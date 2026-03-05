import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const CalculatorToolSchema = Type.Object({
  expression: Type.String({
    description:
      "Math expression to evaluate. Supports +, -, *, /, %, ^, parentheses, constants pi/e, and functions like sqrt, abs, min, max, pow, round.",
  }),
});

const MAX_EXPRESSION_LENGTH = 512;
const MAX_PARSE_STEPS = 512;

type Token =
  | { type: "number"; value: number; raw: string }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: string }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma" }
  | { type: "eof" };

type FunctionDefinition = {
  minArgs: number;
  maxArgs: number;
  call: (args: number[]) => number;
};

const CONSTANTS = new Map<string, number>([
  ["pi", Math.PI],
  ["e", Math.E],
]);

const FUNCTIONS = new Map<string, FunctionDefinition>([
  ["abs", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.abs(value) }],
  ["ceil", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.ceil(value) }],
  ["floor", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.floor(value) }],
  ["sqrt", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.sqrt(value) }],
  ["exp", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.exp(value) }],
  ["ln", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.log(value) }],
  ["log", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.log10(value) }],
  ["log10", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.log10(value) }],
  ["sin", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.sin(value) }],
  ["cos", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.cos(value) }],
  ["tan", { minArgs: 1, maxArgs: 1, call: ([value]) => Math.tan(value) }],
  ["min", { minArgs: 1, maxArgs: 8, call: (args) => Math.min(...args) }],
  ["max", { minArgs: 1, maxArgs: 8, call: (args) => Math.max(...args) }],
  ["pow", { minArgs: 2, maxArgs: 2, call: ([left, right]) => left ** right }],
  [
    "round",
    {
      minArgs: 1,
      maxArgs: 2,
      call: ([value, digits = 0]) => {
        const places = Math.trunc(digits);
        if (places < -15 || places > 15) {
          throw new Error("round digits must be between -15 and 15");
        }
        const factor = 10 ** places;
        if (!Number.isFinite(factor) || factor === 0) {
          throw new Error("round digits produced an invalid factor");
        }
        return Math.round(value * factor) / factor;
      },
    },
  ],
]);

class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculatorError";
  }
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];
    if (!char) {
      break;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === ",") {
      tokens.push({ type: "comma" });
      index += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index += 1;
      continue;
    }
    if ("+-*/%^".includes(char)) {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }

    const remaining = expression.slice(index);
    const numberMatch = /^(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(remaining);
    if (numberMatch) {
      const raw = numberMatch[0] ?? "";
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new CalculatorError(`Invalid numeric literal: ${raw}`);
      }
      tokens.push({ type: "number", value, raw });
      index += raw.length;
      continue;
    }

    const identifierMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(remaining);
    if (identifierMatch) {
      const raw = identifierMatch[0] ?? "";
      tokens.push({ type: "identifier", value: raw.toLowerCase() });
      index += raw.length;
      continue;
    }

    throw new CalculatorError(`Unexpected character: ${char}`);
  }

  tokens.push({ type: "eof" });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private steps = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const value = this.parseExpression();
    this.expect("eof");
    return value;
  }

  private parseExpression(): number {
    return this.parseAdditive();
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative();
    while (true) {
      const next = this.peek();
      if (next.type !== "operator" || (next.value !== "+" && next.value !== "-")) {
        return value;
      }
      this.consume();
      const right = this.parseMultiplicative();
      value = next.value === "+" ? value + right : value - right;
      this.ensureFinite(value, `Operation ${next.value} produced a non-finite result`);
    }
  }

  private parseMultiplicative(): number {
    let value = this.parsePower();
    while (true) {
      const next = this.peek();
      if (next.type !== "operator" || !["*", "/", "%"].includes(next.value)) {
        return value;
      }
      this.consume();
      const right = this.parsePower();
      if ((next.value === "/" || next.value === "%") && right === 0) {
        throw new CalculatorError("Division or modulo by zero is not allowed");
      }
      if (next.value === "*") {
        value *= right;
      } else if (next.value === "/") {
        value /= right;
      } else {
        value %= right;
      }
      this.ensureFinite(value, `Operation ${next.value} produced a non-finite result`);
    }
  }

  private parsePower(): number {
    let value = this.parseUnary();
    const next = this.peek();
    if (next.type === "operator" && next.value === "^") {
      this.consume();
      const exponent = this.parsePower();
      value = value ** exponent;
      this.ensureFinite(value, "Exponentiation produced a non-finite result");
    }
    return value;
  }

  private parseUnary(): number {
    const next = this.peek();
    if (next.type === "operator" && (next.value === "+" || next.value === "-")) {
      this.consume();
      const value = this.parseUnary();
      return next.value === "-" ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.peek();
    if (token.type === "number") {
      this.consume();
      return token.value;
    }
    if (token.type === "identifier") {
      this.consume();
      if (this.match("paren", "(")) {
        return this.parseFunctionCall(token.value);
      }
      const constant = CONSTANTS.get(token.value);
      if (constant === undefined) {
        throw new CalculatorError(`Unknown identifier: ${token.value}`);
      }
      return constant;
    }
    if (token.type === "paren" && token.value === "(") {
      this.consume();
      const value = this.parseExpression();
      this.expect("paren", ")");
      return value;
    }
    throw new CalculatorError(`Unexpected token: ${this.describe(token)}`);
  }

  private parseFunctionCall(name: string): number {
    const definition = FUNCTIONS.get(name);
    if (!definition) {
      throw new CalculatorError(`Unknown function: ${name}`);
    }

    const args: number[] = [];
    if (this.match("paren", ")")) {
      return this.invokeFunction(name, definition, args);
    }

    while (true) {
      args.push(this.parseExpression());
      if (this.match("paren", ")")) {
        return this.invokeFunction(name, definition, args);
      }
      this.expect("comma");
    }
  }

  private invokeFunction(name: string, definition: FunctionDefinition, args: number[]): number {
    if (args.length < definition.minArgs || args.length > definition.maxArgs) {
      if (definition.minArgs === definition.maxArgs) {
        throw new CalculatorError(`${name} expects ${definition.minArgs} argument(s)`);
      }
      throw new CalculatorError(
        `${name} expects between ${definition.minArgs} and ${definition.maxArgs} arguments`,
      );
    }
    const value = definition.call(args);
    this.ensureFinite(value, `${name} produced a non-finite result`);
    return value;
  }

  private ensureFinite(value: number, message: string) {
    if (!Number.isFinite(value)) {
      throw new CalculatorError(message);
    }
  }

  private match(type: Token["type"], value?: string): boolean {
    const token = this.peek();
    if (token.type !== type) {
      return false;
    }
    if (value !== undefined && "value" in token && token.value !== value) {
      return false;
    }
    this.consume();
    return true;
  }

  private expect(type: Token["type"], value?: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new CalculatorError(`Expected ${value ?? type}, got ${this.describe(token)}`);
    }
    if (value !== undefined && "value" in token && token.value !== value) {
      throw new CalculatorError(`Expected ${value}, got ${this.describe(token)}`);
    }
    return this.consume();
  }

  private peek(): Token {
    const token = this.tokens[this.index];
    if (!token) {
      return { type: "eof" };
    }
    return token;
  }

  private consume(): Token {
    this.steps += 1;
    if (this.steps > MAX_PARSE_STEPS) {
      throw new CalculatorError("Expression is too complex");
    }
    const token = this.tokens[this.index];
    this.index += 1;
    return token ?? { type: "eof" };
  }

  private describe(token: Token): string {
    if (token.type === "number") {
      return token.raw;
    }
    if (token.type === "identifier" || token.type === "operator" || token.type === "paren") {
      return token.value;
    }
    return token.type;
  }
}

function formatResult(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toPrecision(15).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1");
}

function evaluateExpression(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new CalculatorError("expression required");
  }
  if (trimmed.length > MAX_EXPRESSION_LENGTH) {
    throw new CalculatorError(
      `Expression is too long (${trimmed.length} > ${MAX_EXPRESSION_LENGTH})`,
    );
  }
  const tokens = tokenize(trimmed);
  return new Parser(tokens).parse();
}

export function createCalculatorTool(): AnyAgentTool {
  return {
    label: "Calculator",
    name: "calculator",
    description:
      "Evaluate arithmetic and math expressions deterministically. Use for calculations that should be exact or tool-backed rather than mental math.",
    parameters: CalculatorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const expression = readStringParam(params, "expression", { required: true });
      try {
        const result = evaluateExpression(expression);
        const formatted = formatResult(result);
        return jsonResult({
          ok: true,
          expression,
          result,
          resultText: formatted,
          source: "deterministic-calculator",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({
          ok: false,
          error: "invalid_expression",
          message,
          expression,
        });
      }
    },
  };
}
