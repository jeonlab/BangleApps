#!/usr/bin/node
/*

This allows us to test apps using the Bangle.js emulator

IT IS UNFINISHED

It searches for `test.json` in each app's directory and will
run them in sequence.

TODO:

* more code to test with
* run tests that we have found and loaded (currently we just use TEST)
* documentation
* actual tests
* detecting 'Uncaught Error'
* logging of success/fail
* ...

*/

var EMULATOR = "banglejs2";
var DEVICEID = "BANGLEJS2";

var BASE_DIR = __dirname + "/..";
var APP_DIR = BASE_DIR + "/apps";
var DIR_IDE =  BASE_DIR + "/../EspruinoWebIDE";


if (!require("fs").existsSync(DIR_IDE)) {
  console.log("You need to:");
  console.log("  git clone https://github.com/espruino/EspruinoWebIDE");
  console.log("At the same level as this project");
  process.exit(1);
}

const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

var AppInfo = require(BASE_DIR+"/core/js/appinfo.js");
var apploader = require(BASE_DIR+"/core/lib/apploader.js");
apploader.init({
  DEVICEID : DEVICEID
});
var emu = require(BASE_DIR+"/core/lib/emulator.js");

// Last set of text received
var lastTxt;

function getSanitizedLastLine(){
  return emu.getLastLine().replaceAll("\r", "");
}

function ERROR(s) {
  console.error(s);
  process.exit(1);
}

function getValue(js){
  if(verbose)
    console.log(`> GETTING VALUE FOR \`${js}\``);
  emu.tx(`\x10print(JSON.stringify(${js}))\n`);
  var result = getSanitizedLastLine();
  
  if (verbose)
    console.log(`  GOT \`${result}\``);
  return JSON.parse(result);
}

function assertArray(step){
  let isOK;
  switch (step.is.toLowerCase()){
    case "notempty": isOK = getValue(`${step.js} && ${step.js}.length > 0`); break;
    case "undefinedorempty": isOK = getValue(`!${step.js} || (${step.js} && ${step.js}.length === 0)`); break;
  }

  if (isOK)
    console.log("> OK - ASSERT ARRAY " + step.is.toUpperCase(), step.text ? "- " + step.text : "");
  else
    console.log("> FAIL - ASSERT ARRAY " + step.is.toUpperCase(), step.text ? "- " + step.text : "");
  return isOK;
}

function assertValue(step){
  let isOK;
  switch (step.is.toLowerCase()){
    case "truthy": isOK = getValue(`!!${step.js}`); break;
    case "falsy": isOK = getValue(`!${step.js}`); break;
    case "true": isOK = getValue(`${step.js} === true`); break;
    case "false": isOK = getValue(`${step.js} === false`); break;
    case "equal": isOK = getValue(`${step.js} == ${step.to}`); break;
    case "function": isOK = getValue(`typeof ${step.js} === "function"`); break;
  }

  if (isOK)
    console.log("> OK - ASSERT " + step.is.toUpperCase(), step.text ? "- " + step.text : "");
  else
    console.log("> FAIL - ASSERT " + step.is.toUpperCase(), step.text ? "- " + step.text : "");
  return isOK;
}

function wrap(func, id){
  console.log(`> Wrapping "${func}"`);

  let wrappingCode = `
  if(!global.APPTESTS) global.APPTESTS={};
  if(!global.APPTESTS.funcCalls) global.APPTESTS.funcCalls={};
  if(!global.APPTESTS.funcArgs) global.APPTESTS.funcArgs={};
  global.APPTESTS.funcCalls.${id}=0;
  (function(o) {
    ${func} = function() {
      global.APPTESTS.funcCalls.${id}++;
      global.APPTESTS.funcArgs.${id}=arguments;
      return o.apply(this, arguments);
    };
  }(${func}));`;

  emu.tx(wrappingCode);
}

function assertCall(step){
  let isOK = false;
  let id = step.id;
  let args = step.argAsserts;
  let calls = getValue(`global.APPTESTS.funcCalls.${id}`);
  if ((args.count && args.count == calls) || (!args.count && calls > 0)){
    if (args) {
      let callArgs = getValue(`global.APPTESTS.funcArgs.${id}`);
      for (let a of args){
        let current = {
          value: callArgs[a.arg],
          is: a.is,
          to: a.to,
          text: step.text
        };
        switch(a.t){
          case "assertArray":
            isOK = assertArray(current);
            break;
          case "assert":
            isOK =  assertValue(current);
            break;
        }
      }
    } else {
      isOK = true;
    }
  }
  if (isOK)
    console.log("OK - ASSERT CALL", step.text ? "- " + step.text : "");
  else
    console.log("FAIL - ASSERT CALL", step.text ? "- " + step.text : "");
  return isOK;
}

function runStep(step, subtest, test, state){
  let p = Promise.resolve();
  if (state.ok) switch(step.t) {
    case "setup" :
      test.setup.filter(e=>e.id==step.id)[0].steps.forEach(setupStep=>{
        p = p.then(()=>{
          let np = runStep(setupStep, subtest, test, state);
          emu.idle();
          return np;
        });
      });
      break;
    case "load" :
      p = p.then(() => {
        console.log(`> LOADING FILE "${step.fn}"`);
        emu.tx(`load(${JSON.stringify(step.fn)})\n`);
      });
      break;
    case "cmd" :
      p = p.then(() => {
        console.log(`> SENDING JS \`${step.js}\``, step.text ? "- " + step.text : "");
        emu.tx(`${step.js}\n`);
      });
      break;
    case "wrap" :
      p = p.then(() => {
        wrap(step.fn, step.id);
      });
      break;
    case "gb" : 
      p = p.then(() => {
        let obj = Object.apply({
          src:'Messenger',
          t: 'notify',
          type: 'text',
          id: Date.now().toFixed(0),
          title:'title',
          body:'body'
        }, step.obj || {});
        emu.tx(`GB(${JSON.stringify(obj)})\n`);
      });
      break;
    case "emit" :
      p = p.then(() => {
        let parent = step.parent ? step.parent : "Bangle";
        if (!step.paramsArray) step.paramsArray = [];
        let args = JSON.stringify([step.event].concat(step.paramsArray));
        console.log(`> EMIT "${step.event}" on ${parent} with parameters ${JSON.stringify(step.paramsArray, null, null)}`);
        
        emu.tx(`${parent}.emit.apply(${parent}, ${args})\n`);
      });
      break;
    case "eval" :
      p = p.then(() => {
        console.log(`> Evaluate "${step.js}"`);
        emu.tx(`\x10print(JSON.stringify(${step.js}))\n`);
        var result = getSanitizedLastLine();
        var expected = JSON.stringify(step.eq);
        console.log("> GOT `"+result+"`");
        if (result!=expected) {
          console.log("> FAIL: EXPECTED "+expected);
          state.ok = false;
        }
      });
      break;
      // tap/touch/drag/button press
      // delay X milliseconds?
    case "assertArray":
      p = p.then(() => {
        state.ok &= assertArray(step);
      });
      break;
    case "assertCall":
      p = p.then(() => {
        state.ok &= assertCall(step);
      });
      break;
    case "assert":
      p = p.then(() => {
        state.ok &= assertValue(step);
      });
      break;
    case "screenshot" :
      p = p.then(() => {
        console.log(`> Compare screenshots - UNIMPLEMENTED`);
      });
      break;
    case "saveMemoryUsage" :
      p = p.then(() => {
        emu.tx(`\x10print(process.memory().usage)\n`);
        subtest.memUsage = parseInt( getSanitizedLastLine());
        console.log("> CURRENT MEMORY USAGE", subtest.memUsage);
      });
      break;
    case "checkMemoryUsage" :
      p = p.then(() => {
        emu.tx(`\x10print(process.memory().usage)\n`);
        var memUsage =  getSanitizedLastLine();
        console.log("> CURRENT MEMORY USAGE", memUsage);
        if (subtest.memUsage != memUsage ) {
          console.log("> FAIL: EXPECTED MEMORY USAGE OF "+subtest.memUsage);
          state.ok = false;
        }
      });
      break;
    case "sleep" :
      p = p.then(()=>{
        return new Promise(resolve => {
          setTimeout(()=>{
            console.log("> WAITED FOR", step.ms);
            resolve();
          }, step.ms);
        })
      });
      break;
    case "upload" :
      p = p.then(()=>{
        console.log("> UPLOADING" + (step.load ? " AND LOADING" : ""), step.file);
        emu.tx(AppInfo.getFileUploadCommands(step.as, require("fs").readFileSync(BASE_DIR + "/" + step.file).toString()));
        if (step.load){
          emu.tx(`\x10load("${step.as}")`);
        }
      });
      break;
    case "console" :
      p = p.then(()=>{
        return new Promise(resolve => {
          if (process.stdin.isTTY){
            console.log("> STARTING INTERACTIVE CONSOLE");

            let shutdownHandler = function (code) {
              console.log(" STOPPING INTERACTIVE CONSOLE");
              process.stdin.removeListener("readable", stdinlistener)
              process.stdin.setRawMode(false);
              handleRx = ()=>{};
              handleConsoleOutput = handleConsoleOutputCurrent;
              resolve();
            }

            let stdinlistener = () => {
              while ((chunk = process.stdin.read()) !== null) {
                if (chunk === '\x03') {
                  shutdownHandler();
                }
                emu.tx(chunk.toString());
              }
            };

            handleRx = (c) => {
              process.stdout.write(String.fromCharCode(c));
            }

            let handleConsoleOutputCurrent = handleConsoleOutput;
            handleConsoleOutput = () => {};

            process.stdin.setRawMode(true);
            process.stdin.setEncoding('ASCII');
            process.stdin.on("readable", stdinlistener);

            process.stdout.write(">");
          } else {
            console.log("> TERMINAL NEEDS TO BE A TTY FOR INTERACTIVE CONSOLE");
            resolve();
          }
        })
      });
      break;
    default: ERROR("Unknown step type "+step.t);
  }
  p = p.then(()=> {
    emu.idle();
  });
  return p;
}

function runTest(test, testState) {
  apploader.reset();
  var app = apploader.apps.find(a=>a.id==test.app);
  if (!app) ERROR(`App ${JSON.stringify(test.app)} not found`);
  if (app.custom) ERROR(`App ${JSON.stringify(appId)} requires HTML customisation`);
  
  return apploader.getAppFilesString(app).then(command => {
    let p = Promise.resolve();
    test.tests.forEach((subtest,subtestIdx) => {
      let state = { ok: true};
      p = p.then(()=>{
        console.log(`==============================`);
        console.log(`"${test.app}" Test ${subtestIdx}`);
        if (test.description)
          console.log(`"${test.description}`);
        console.log(`==============================`);
        emu.factoryReset();
        console.log("> SENDING APP "+test.app);
        emu.tx(command);
        console.log("> SENT APP");
        emu.tx("reset()\n");
        console.log("> RESET");

      });

      subtest.steps.forEach(step => {
        p = p.then(()=>{
          return runStep(step, subtest, test, state).catch((e)=>{
            console.log("> STEP FAILED:", e, step);
            state.ok = false;
          })
        });
      });

      p = p.finally(()=>{
        console.log("> RESULT -",  (state.ok ? "OK": "FAIL") , "- " + test.app + (subtest.description ? (" - " + subtest.description) : ""));
        testState.push({
          app: test.app,
          number: subtestIdx,
          result: state.ok ? "SUCCESS": "FAILURE",
          description: subtest.description
        });
      });
    });
    p = p.then(()=>{
      emu.stopIdle();
    });
    return p;
  });
}


let handleRx = ()=>{};
let handleConsoleOutput = () => {};
if (verbose){
  handleConsoleOutput = (d) => {
    console.log("<", d);
  }
}

let testState = [];

emu.init({
  EMULATOR : EMULATOR,
  DEVICEID : DEVICEID,
  rxCallback : (ch)=>{
    handleRx(ch);
  },
  consoleOutputCallback: (d)=>{
    handleConsoleOutput(d);
  }
}).then(function() {
  // Emulator is now loaded
  console.log("Loading tests");
  let p = Promise.resolve();
  let apps = apploader.apps;
  if (process.argv.includes("--id")) {
    let f = process.argv[process.argv.indexOf("--id") + 1];
    apps = apps.filter(e=>e.id==f);
    if (apps.length == 0){
      console.log("No apps left after filtering for " + f);
      process.exitCode(255);
    }
  }

  apps.forEach(app => {
    var testFile = APP_DIR+"/"+app.id+"/test.json";
    if (!require("fs").existsSync(testFile)) return;
    var test = JSON.parse(require("fs").readFileSync(testFile).toString());
    test.app = app.id;
    p = p.then(()=>{
      return runTest(test, testState);
    });
  });
  p.finally(()=>{
    console.log("\n\n");
    console.log("Overall results:");
    console.table(testState);

    process.exit(testState.reduce((a,c)=>{
      return a + ((c.result == "SUCCESS") ? 0 : 1);
    }, 0))
  });
  return p;
});

/*
  if (erroredApps.length) {
    erroredApps.forEach(app => {
      console.log(`::error file=${app.id}::${app.id}`);
      console.log("::group::Log");
      app.log.split("\n").forEach(line => console.log(`\u001b[38;2;255;0;0m${line}`));
      console.log("::endgroup::");
    });
    process.exit(1);
  }
*/
