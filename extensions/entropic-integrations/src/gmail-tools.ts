import { Buffer } from "node:buffer";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getGoogleAccessToken } from "./google.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(
  params: Record<string, unknown>,
  key: string,
  def?: number,
): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return def;
}

function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

async function gmailFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GMAIL_API_BASE}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function createGmailSearchTool(_api: OpenClawPluginApi) {
  return {
    name: "gmail_search",
    label: "Gmail Search",
    description: "Search Gmail messages using Gmail query syntax.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Gmail search query (e.g., from:alice newer_than:7d)." }),
      ),
      maxResults: Type.Optional(
        Type.Number({ description: "Max messages to return (default 10)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = readString(params, "query") || "in:inbox";
      const maxResults = readNumber(params, "maxResults", 10) ?? 10;
      const token = await getGoogleAccessToken("google_email");

      const list = await gmailFetch<{
        messages?: Array<{ id: string; threadId: string }>;
        resultSizeEstimate?: number;
      }>(`messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`, token);

      const messages = list.messages || [];
      const details = await Promise.all(
        messages.map(async (msg) => {
          const data = await gmailFetch<any>(
            `messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            token,
          );
          const headers = Array.isArray(data.payload?.headers) ? data.payload.headers : [];
          const subject = headers.find((h: any) => h.name === "Subject")?.value || "";
          const from = headers.find((h: any) => h.name === "From")?.value || "";
          const date = headers.find((h: any) => h.name === "Date")?.value || "";
          return {
            id: data.id,
            threadId: data.threadId,
            subject,
            from,
            date,
            snippet: data.snippet,
          };
        }),
      );

      return jsonResult({ query, resultSizeEstimate: list.resultSizeEstimate, messages: details });
    },
  };
}

export function createGmailGetTool(_api: OpenClawPluginApi) {
  return {
    name: "gmail_get",
    label: "Gmail Get",
    description: "Fetch a Gmail message by id.",
    parameters: Type.Object({
      id: Type.String({ description: "Gmail message id." }),
      format: Type.Optional(
        Type.String({ description: "Format: metadata or full (default metadata)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const msgId = readString(params, "id");
      if (!msgId) throw new Error("id required");
      const format = readString(params, "format") || "metadata";
      const token = await getGoogleAccessToken("google_email");
      const data = await gmailFetch<any>(
        `messages/${msgId}?format=${encodeURIComponent(format)}`,
        token,
      );
      return jsonResult(data);
    },
  };
}

export function createGmailSendTool(_api: OpenClawPluginApi) {
  return {
    name: "gmail_send",
    label: "Gmail Send",
    description: "Send an email via Gmail.",
    parameters: Type.Object({
      to: Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "Recipient email(s).",
      }),
      subject: Type.String({ description: "Email subject." }),
      body: Type.String({ description: "Email body (plain text)." }),
      cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
      bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const toRaw = params.to;
      const subject = readString(params, "subject");
      const body = readString(params, "body");
      if (!subject || !body) throw new Error("subject and body required");

      const normalizeList = (value: unknown): string[] => {
        if (Array.isArray(value)) {
          return value
            .filter((v) => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean);
        }
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed ? [trimmed] : [];
        }
        return [];
      };

      const to = normalizeList(toRaw);
      if (to.length === 0) throw new Error("to required");
      const cc = normalizeList(params.cc);
      const bcc = normalizeList(params.bcc);

      const lines = [
        `To: ${to.join(", ")}`,
        cc.length ? `Cc: ${cc.join(", ")}` : "",
        bcc.length ? `Bcc: ${bcc.join(", ")}` : "",
        `Subject: ${encodeHeader(subject)}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].filter(Boolean);

      const rawEmail = lines.join("\r\n");
      const encodedEmail = Buffer.from(rawEmail, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const token = await getGoogleAccessToken("google_email");
      const result = await gmailFetch<any>("messages/send", token, {
        method: "POST",
        body: JSON.stringify({ raw: encodedEmail }),
      });

      return jsonResult({ id: result.id, threadId: result.threadId, status: "sent" });
    },
  };
}

export function createGmailDraftTool(_api: OpenClawPluginApi) {
  return {
    name: "gmail_draft",
    label: "Gmail Draft",
    description: "Create an email draft in Gmail (saves without sending).",
    parameters: Type.Object({
      to: Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "Recipient email(s).",
      }),
      subject: Type.String({ description: "Email subject." }),
      body: Type.String({ description: "Email body (plain text)." }),
      cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
      bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const toRaw = params.to;
      const subject = readString(params, "subject");
      const body = readString(params, "body");
      if (!subject || !body) throw new Error("subject and body required");

      const normalizeList = (value: unknown): string[] => {
        if (Array.isArray(value)) {
          return value
            .filter((v) => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean);
        }
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed ? [trimmed] : [];
        }
        return [];
      };

      const to = normalizeList(toRaw);
      if (to.length === 0) throw new Error("to required");
      const cc = normalizeList(params.cc);
      const bcc = normalizeList(params.bcc);

      const lines = [
        `To: ${to.join(", ")}`,
        cc.length ? `Cc: ${cc.join(", ")}` : "",
        bcc.length ? `Bcc: ${bcc.join(", ")}` : "",
        `Subject: ${encodeHeader(subject)}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].filter(Boolean);

      const rawEmail = lines.join("\r\n");
      const encodedEmail = Buffer.from(rawEmail, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const token = await getGoogleAccessToken("google_email");
      const result = await gmailFetch<any>("drafts", token, {
        method: "POST",
        body: JSON.stringify({ message: { raw: encodedEmail } }),
      });

      return jsonResult({ id: result.id, draftId: result.id, status: "draft_created" });
    },
  };
}
