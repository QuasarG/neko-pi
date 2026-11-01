import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { AskUserDock } = await jiti.import("./AskUserDock.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const request = { type: "extension_ui_request", id: "r1", method: "select", title: "Which database?", options: ["Postgres", "SQLite", "Redis"] };
const multiQuestion = {
  question: "Which database?",
  options: [{ label: "Postgres", description: "production data" }, { label: "SQLite" }, { label: "Redis" }],
  background: false,
  multiSelect: true,
};
const singleQuestion = { ...multiQuestion, multiSelect: false };

function captureDock(question, onRespond) {
  let tree = null;
  // useI18n needs React's hook dispatcher and the provider, so capture the
  // component's tree from inside a real render under I18nProvider.
  const CaptureDock = (props) => (tree = AskUserDock(props));
  renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(CaptureDock, { request, question, waitingCount: 0, onRespond })),
  );
  return tree;
}

function collect(node, pred, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, pred, found));
    return found;
  }
  if (pred(node)) found.push(node);
  collect(node.props?.children, pred, found);
  return found;
}

test("multi-select questions render toggleable checkboxes", () => {
  const tree = captureDock(multiQuestion, () => {});
  const inputs = collect(tree, (node) => node.type === "input");
  assert.equal(inputs.length, 3);
  for (const input of inputs) {
    assert.equal(input.props.type, "checkbox");
    assert.equal(input.props.checked, false);
  }
  assert.equal(collect(tree, (node) => node.type === "textarea").length, 1);
});

test("single-select questions keep radio semantics", () => {
  const tree = captureDock(singleQuestion, () => {});
  const inputs = collect(tree, (node) => node.type === "input");
  assert.equal(inputs.length, 3);
  for (const input of inputs) assert.equal(input.props.type, "radio");
});

test("an empty selection cannot submit in either mode", () => {
  for (const question of [singleQuestion, multiQuestion]) {
    const responded = [];
    const tree = captureDock(question, (_req, response) => responded.push(response));
    const submit = collect(tree, (node) => node.type === "button" && node.props.type === "submit");
    assert.equal(submit.length, 1);
    assert.equal(submit[0].props.disabled, true);
    // A synthetic submit (Enter in the textarea) must not send anything either.
    const form = collect(tree, (node) => node.type === "form")[0];
    form.props.onSubmit({ preventDefault() {} });
    assert.deepEqual(responded, []);
  }
});

test("multi-select happy path: tick two options, submit sends both labels as one array", () => {
  const responded = [];
  // Drive the dock's own state through renders inside React: each render pass
  // performs one click through the onChange closure captured from that pass's
  // tree (a closure from an earlier pass would compute from stale state), the
  // render-phase update re-renders, and the settled tree is captured.
  let settledTree = null;
  // Click SQLite first, then Postgres: submit must still send displayed order.
  const pendingClicks = ["SQLite", "Postgres"];
  function DockHarness() {
    settledTree = AskUserDock({ request, question: multiQuestion, waitingCount: 0, onRespond: (_req, response) => responded.push(response) });
    const label = pendingClicks.shift();
    if (label !== undefined) {
      const input = collect(settledTree, (node) => node.type === "input" && node.props.value === label)[0];
      input.props.onChange();
    }
    return settledTree;
  }
  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(DockHarness)));

  const inputs = collect(settledTree, (node) => node.type === "input");
  assert.deepEqual(inputs.map((input) => input.props.checked), [true, true, false]);
  const submit = collect(settledTree, (node) => node.type === "button" && node.props.type === "submit")[0];
  assert.equal(submit.props.disabled, false);

  collect(settledTree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(responded, [{ values: ["Postgres", "SQLite"] }]);
});
