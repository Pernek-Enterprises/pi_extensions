import test from "node:test";
import assert from "node:assert/strict";

import { PlanningQnAComponent } from "../../extensions/planning/question-ui.ts";

test("PlanningQnAComponent renders the current question and answer prompt", () => {
	const component = new PlanningQnAComponent([
		{ id: "q-1", question: "Is the bug still reproducible?", status: "open" },
		{ id: "q-2", question: "Is dashboard config in scope?", status: "open" },
	], {
		requestRender() {},
	} as any, () => {});

	const output = component.render(80).join("\n");
	assert.match(output, /Answer planning questions 1\/2/);
	assert.match(output, /Is the bug still reproducible\?/);
	assert.match(output, /Answer:/);
});
