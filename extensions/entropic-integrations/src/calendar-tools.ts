import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getGoogleAccessToken } from "./google.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

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

async function calendarFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CALENDAR_API_BASE}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function createCalendarListTool(_api: OpenClawPluginApi) {
  return {
    name: "calendar_list",
    label: "Calendar List",
    description: "List upcoming Google Calendar events.",
    parameters: Type.Object({
      timeMin: Type.Optional(Type.String({ description: "Start time ISO8601." })),
      timeMax: Type.Optional(Type.String({ description: "End time ISO8601." })),
      maxResults: Type.Optional(Type.Number({ description: "Max events to return (default 10)." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const token = await getGoogleAccessToken("google_calendar");
      const timeMin = readString(params, "timeMin");
      const timeMax = readString(params, "timeMax");
      const maxResults = readNumber(params, "maxResults", 10) ?? 10;

      const search = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(maxResults),
      });
      if (timeMin) search.set("timeMin", timeMin);
      if (timeMax) search.set("timeMax", timeMax);

      const data = await calendarFetch<any>(`events?${search.toString()}`, token);
      const events = Array.isArray(data.items)
        ? data.items.map((item: any) => ({
            id: item.id,
            summary: item.summary,
            start: item.start?.dateTime ?? item.start?.date,
            end: item.end?.dateTime ?? item.end?.date,
            attendees: Array.isArray(item.attendees)
              ? item.attendees.map((a: any) => a.email).filter(Boolean)
              : [],
          }))
        : [];

      return jsonResult({ events });
    },
  };
}

export function createCalendarCreateTool(_api: OpenClawPluginApi) {
  return {
    name: "calendar_create",
    label: "Calendar Create",
    description: "Create a Google Calendar event.",
    parameters: Type.Object({
      summary: Type.String({ description: "Event summary/title." }),
      description: Type.Optional(Type.String({ description: "Event description." })),
      start: Type.String({ description: "Start time ISO8601." }),
      end: Type.String({ description: "End time ISO8601." }),
      attendees: Type.Optional(Type.Array(Type.String({ description: "Attendee email." }))),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const summary = readString(params, "summary");
      const start = readString(params, "start");
      const end = readString(params, "end");
      if (!summary || !start || !end) {
        throw new Error("summary, start, and end required");
      }
      const token = await getGoogleAccessToken("google_calendar");
      const description = readString(params, "description");
      const attendees = Array.isArray(params.attendees)
        ? (params.attendees as unknown[])
            .filter((v) => typeof v === "string")
            .map((v) => v as string)
        : undefined;

      const payload = {
        summary,
        description,
        start: { dateTime: start },
        end: { dateTime: end },
        attendees: attendees?.map((email) => ({ email })),
      };

      const data = await calendarFetch<any>("events", token, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      return jsonResult({ id: data.id, status: data.status ?? "created" });
    },
  };
}
