import { describe, expect, it } from "vitest";
import { createCalculatorTool } from "./calculator-tool.js";

function requireCalculatorTool() {
  const tool = createCalculatorTool();
  expect(tool).toBeDefined();
  return tool;
}

describe("calculator tool", () => {
  it("evaluates arithmetic expressions deterministically", async () => {
    const tool = requireCalculatorTool();
    const result = await tool.execute("call-1", {
      expression: "2 + 2 * (3 + 4)",
    });

    expect(result.details).toMatchObject({
      ok: true,
      expression: "2 + 2 * (3 + 4)",
      result: 16,
      resultText: "16",
      source: "deterministic-calculator",
    });
  });

  it("supports constants and math functions", async () => {
    const tool = requireCalculatorTool();
    const result = await tool.execute("call-2", {
      expression: "round(pow(pi, 2), 3)",
    });

    expect(result.details).toMatchObject({
      ok: true,
      result: 9.87,
      resultText: "9.87",
    });
  });

  it("returns a structured error for invalid expressions", async () => {
    const tool = requireCalculatorTool();
    const result = await tool.execute("call-3", {
      expression: "2 / 0",
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: "invalid_expression",
      expression: "2 / 0",
    });
    expect((result.details as { message?: string }).message).toContain("zero");
  });
});
