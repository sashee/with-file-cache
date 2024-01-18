import {withFileCache} from "../index.js";
import {workerData, parentPort} from "node:worker_threads";
import {mock} from "node:test";
import {setTimeout} from "node:timers/promises";

const fn = mock.fn((arg: string) => {
	// just to prevent infinite waiting
	return setTimeout(1000);
});

const res2Prom = withFileCache({baseKey: () => workerData.testId, broadcastChannelName: workerData.testId})(fn, {calcCacheKey: (arg) => arg})("a");
parentPort?.postMessage({type: "started"});

parentPort!.on("message", async (msg) => {
	if (msg === "check") {
		await res2Prom;
		parentPort?.postMessage({type: "calls", calls: fn.mock.calls.length, res: await res2Prom});
	}
});

