import assert from "node:assert/strict";
import test from "node:test";

const { skillCommandToSessionText, skillInvocationCommand } = await import("./skill-command.ts");

const known = new Set(["review", "chrome-emoji-fix"]);

test("a known #skill becomes the /skill: command pi expands", () => {
  assert.equal(skillCommandToSessionText("#review src/main.ts", known), "/skill:review src/main.ts");
  assert.equal(skillCommandToSessionText("#review", known), "/skill:review");
  assert.equal(
    skillCommandToSessionText("#chrome-emoji-fix 帮我修一下", known),
    "/skill:chrome-emoji-fix 帮我修一下",
  );
});

test("multiline arguments survive the rewrite", () => {
  assert.equal(skillCommandToSessionText("#review first\nsecond", known), "/skill:review first\nsecond");
});

test("an unknown or mid-text # stays literal text", () => {
  assert.equal(skillCommandToSessionText("#nope args", known), "#nope args");
  assert.equal(skillCommandToSessionText("please #review this", known), "please #review this");
  assert.equal(skillCommandToSessionText("## heading", known), "## heading");
});

test("the transcript form is #name, with arguments beside it", () => {
  assert.equal(skillInvocationCommand("review", "src/main.ts"), "#review src/main.ts");
  assert.equal(skillInvocationCommand("review"), "#review");
});
