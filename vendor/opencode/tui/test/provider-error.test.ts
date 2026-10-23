import { expect, test } from "bun:test"
import { providerErrorMessage } from "../src/util/provider-error"

test("provider errors explain a concrete recovery action and preserve unknown errors", () => {
  expect(providerErrorMessage('{"error":{"code":"1301","message":"rejected"}}')).toContain("edit the message")
  expect(providerErrorMessage("HTTP 401 unauthorized")).toContain("sign in again")
  expect(providerErrorMessage("429 too many requests")).toContain("Wait before retrying")
  expect(providerErrorMessage("HTTP 503 service unavailable")).toContain("provider service failed")
  expect(providerErrorMessage("fetch failed")).toContain("Check your connection")
  expect(providerErrorMessage("Unknown vendor detail")).toBe("Unknown vendor detail")
})
