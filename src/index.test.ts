import {describe, it} from "node:test";
import { strict as assert } from "node:assert";
import {test} from "./index.js";

describe("index", () => {
	it("works", async () => {
		assert.equal(test(), "Hello world");
	});
});
