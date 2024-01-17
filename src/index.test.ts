import {describe, it, mock} from "node:test";
import { strict as assert } from "node:assert";
import {withFileCache} from "./index.js";
import crypto from "node:crypto";

describe("basic", () => {
	it("allows returning undefined, null, and empty string", async () => {
		const testId = crypto.randomUUID();
		const cachedFunction = withFileCache(() => testId)((arg: string | undefined | null) => {
			return arg;
		}, {calcCacheKey: (arg) => [typeof arg, String(arg)]});
		await cachedFunction(null);
		assert.equal(await cachedFunction(null), null);
		await cachedFunction(undefined);
		assert.equal(await cachedFunction(undefined), undefined);
		await cachedFunction("");
		assert.equal(await cachedFunction(""), "");
	});
	it("calls the function for different cache keys", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: string) => {
		});
		const cachedFunction = withFileCache(() => testId)(fn, {calcCacheKey: (arg) => arg});
		await cachedFunction("a");
		assert.equal(fn.mock.calls.length, 1);
		await cachedFunction("b");
		assert.equal(fn.mock.calls.length, 2);
	});
	it("does not call the function when a cache key was already calculated", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: string) => {
		});
		const cachedFunction = withFileCache(() => testId)(fn, {calcCacheKey: (arg) => arg});
		await cachedFunction("a");
		assert.equal(fn.mock.calls.length, 1);
		await cachedFunction("a");
		assert.equal(fn.mock.calls.length, 1);
	});
	describe("baseKey", () => {
		it("different baseKeys result in different cache keys", async () => {
			const testId = crypto.randomUUID();
			const fn = mock.fn((arg: string) => {
			});
			await withFileCache(() => testId + "1")(fn, {calcCacheKey: (arg) => arg})("a");
			assert.equal(fn.mock.calls.length, 1);
			await withFileCache(() => testId + "2")(fn, {calcCacheKey: (arg) => arg})("a");
	 		assert.equal(fn.mock.calls.length, 2);
		});
		it("same baseKeys result in the same cache keys", async () => {
			const testId = crypto.randomUUID();
			const fn = mock.fn((arg: string) => {
			});
			await withFileCache(() => testId + "1")(fn, {calcCacheKey: (arg) => arg})("a");
			assert.equal(fn.mock.calls.length, 1);
			await withFileCache(() => testId + "1")(fn, {calcCacheKey: (arg) => arg})("a");
	 		assert.equal(fn.mock.calls.length, 1);
		});
	})
});
describe("in-process concurrency", () => {
	it("calls the function once if the same key is calculated concurrently", async () => {
		const testId = crypto.randomUUID();
		let calledResolve: (v: unknown) => void;
		const calledPromise = new Promise((res) => calledResolve = res);
		let resolve: (v: unknown) => void;
		const promise = new Promise((res) => resolve = res);

		const fn = mock.fn((arg: string) => {
			calledResolve!(undefined);
			return promise;
		});
		const cachedFunction = withFileCache(() => testId)(fn, {calcCacheKey: (arg) => arg});
		const res1Prom = cachedFunction("a");
		const res2Prom = cachedFunction("a");
		await calledPromise;
		assert.equal(fn.mock.calls.length, 1);
		resolve!(undefined);
		await res1Prom;
		await res2Prom;
		assert.equal(fn.mock.calls.length, 1);
	});
	it.skip("calls the function once if the same key is calculated concurrently even for different instances", async () => {
		const testId = crypto.randomUUID();
		let calledResolve: (v: unknown) => void;
		const calledPromise = new Promise((res) => calledResolve = res);
		let resolve: (v: unknown) => void;
		const promise = new Promise((res) => resolve = res);

		const fn = mock.fn((arg: string) => {
			calledResolve!(undefined);
			return promise;
		});
		const res1Prom = withFileCache(() => testId)(fn, {calcCacheKey: (arg) => arg})("a");
		const res2Prom = withFileCache(() => testId)(fn, {calcCacheKey: (arg) => arg})("a");
		await calledPromise;
		assert.equal(fn.mock.calls.length, 1);
		resolve!(undefined);
		await res1Prom;
		await res2Prom;
		assert.equal(fn.mock.calls.length, 1);
	});
});
