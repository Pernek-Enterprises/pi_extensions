import test from "node:test";
import assert from "node:assert/strict";

import { PlanningV2QnAComponent } from "../../extensions/planning-v2/question-ui.ts";

test("PlanningV2QnAComponent renders the current question and answer prompt", () => {
	const component = new PlanningV2QnAComponent([
		{ id: "q-1", question: "Is the bug still reproducible?", status: "open" },
		{ id: "q-2", question: "Is dashboard config in scope?", status: "open" },
	], {
		requestRender() {},
	} as any, () => {});

	const output = component.render(80);
	assert.match(output, /Answer planning questions 1\/2/);
	assert.match(output, /Is the bug still reproducible\?/);
	assert.match(output, /Answer:/);
});
