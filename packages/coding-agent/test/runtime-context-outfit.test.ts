import { describe, expect, test } from "vitest";
import { outfitDeliveryPlan, outfitNarrationGuidance } from "../src/extensions/runtime-context/index.ts";

describe("outfitDeliveryPlan", () => {
	test("same fingerprint as the session's last delivery says nothing", () => {
		expect(outfitDeliveryPlan(100, 100, undefined)).toEqual({ deliver: false, firstNarration: false });
		// Even when the global narration receipt is missing: this session
		// already saw the outfit, so there is nothing new to say at all.
		expect(outfitDeliveryPlan(100, 100, 999)).toEqual({ deliver: false, firstNarration: false });
	});

	test("a fingerprint never narrated anywhere gets the full first-narration framing", () => {
		expect(outfitDeliveryPlan(200, undefined, undefined)).toEqual({ deliver: true, firstNarration: true });
		expect(outfitDeliveryPlan(200, 100, 100)).toEqual({ deliver: true, firstNarration: true });
	});

	test("a fingerprint already narrated in another session delivers with the neutral framing", () => {
		expect(outfitDeliveryPlan(200, undefined, 200)).toEqual({ deliver: true, firstNarration: false });
		expect(outfitDeliveryPlan(200, 100, 200)).toEqual({ deliver: true, firstNarration: false });
	});

	test("A→B→A re-delivers A and re-checks the global receipt (P2 round-trip)", () => {
		// After A(100)→B(200), back to A: the session receipt holds 200, so A
		// delivers again; if A was already narrated globally it stays neutral.
		expect(outfitDeliveryPlan(100, 200, 100)).toEqual({ deliver: true, firstNarration: false });
	});
});

describe("outfitNarrationGuidance", () => {
	test("nothing delivered appends nothing", () => {
		expect(outfitNarrationGuidance(false, false)).toBe("");
	});

	test("first narration demands an explicit in-character mention", () => {
		const text = outfitNarrationGuidance(true, true);
		expect(text).toContain("explicitly mention");
		expect(text).toContain("changed into this outfit");
	});

	test("neutral narration forbids re-describing the change", () => {
		const text = outfitNarrationGuidance(true, false);
		expect(text).toContain("already wearing");
		expect(text).toContain("do not describe changing into it");
		expect(text).not.toContain("explicitly mention");
	});
});
