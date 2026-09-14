const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('webui/src/joy_interaction_webui/static/index.html', 'utf8');
const code = html.slice(html.indexOf('        let cameraFrameTimer'), html.indexOf('        // Send webcam frames through'));

async function main() {
    const sent = [];
    let timer;
    let encode;
    const context = vm.createContext({
        console, performance, WebSocket: { OPEN: 1 },
        streamStartToken: 1, localStream: {},
        websocket: { readyState: 1, bufferedAmount: 0, send: b => sent.push(b) },
        videoElement: { readyState: 2, videoWidth: 1920, videoHeight: 1080 },
        processEvery: { value: '1' }, framesPerBatch: { value: '1' },
        updateStatus: () => {},
        setTimeout: fn => { timer = fn; return 1; },
        clearTimeout: () => { timer = null; },
        document: { createElement: () => ({
            getContext: () => ({ drawImage: () => {} }),
            toBlob: cb => { encode = cb; },
        }) },
    });
    vm.runInContext(code, context);
    vm.runInContext('startCameraFrames(1)', context);
    encode({ size: 100 });
    await new Promise(setImmediate);
    assert.equal(sent.length, 1);
    await timer();
    assert.equal(sent.length, 1, 'wait for acknowledgement before sending another frame');
    vm.runInContext('cameraFramePending = false', context);
    const capture = timer();
    encode({ size: 100 });
    await capture;
    assert.equal(sent.length, 2);
    vm.runInContext('cameraFramePending = false', context);
    const stopped = timer();
    vm.runInContext('streamStartToken++; stopCameraFrames(); localStream = null', context);
    encode({ size: 100 });
    await stopped;
    assert.equal(sent.length, 2, 'stop during encoding must not send a late frame');
    assert.equal(timer, null);

    context.localStream = {};
    vm.runInContext('startCameraFrames(2)', context);
    context.websocket = { readyState: 1, bufferedAmount: 0, send: b => sent.push(b) };
    encode({ size: 100 });
    await new Promise(setImmediate);
    assert.equal(sent.length, 2, 'discard frames encoded for a replaced connection');
    const resumed = timer();
    encode({ size: 100 });
    await resumed;
    assert.equal(sent.length, 3, 'resume uploads on the new connection');
    console.log('Camera upload tests passed: backpressure, stop, reconnect');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
