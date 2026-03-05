import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runGws } from "./gws.js";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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

function extractContact(person: any) {
  const names = person.names || [];
  const emails = person.emailAddresses || [];
  const phones = person.phoneNumbers || [];
  const orgs = person.organizations || [];
  return {
    resourceName: person.resourceName,
    name: names[0]?.displayName || null,
    emails: emails.map((e: any) => e.value).filter(Boolean),
    phones: phones.map((p: any) => p.value).filter(Boolean),
    organization: orgs[0]?.name || null,
    title: orgs[0]?.title || null,
  };
}

export function createContactsListTool(_api: OpenClawPluginApi) {
  return {
    name: "contacts_list",
    label: "Contacts List",
    description: "List contacts from Google Contacts.",
    parameters: Type.Object({
      pageSize: Type.Optional(
        Type.Number({ description: "Max contacts to return (default 20, max 100)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const pageSize = Math.min(readNumber(params, "pageSize", 20) ?? 20, 100);

      const data = (await runGws(["people", "people", "connections", "list"], {
        params: {
          resourceName: "people/me",
          pageSize,
          personFields: "names,emailAddresses,phoneNumbers,organizations",
          sortOrder: "LAST_NAME_ASCENDING",
        },
      })) as any;

      return jsonResult({
        contacts: (data.connections || []).map(extractContact),
        totalPeople: data.totalPeople,
      });
    },
  };
}

export function createContactsSearchTool(_api: OpenClawPluginApi) {
  return {
    name: "contacts_search",
    label: "Contacts Search",
    description: "Search Google Contacts by name, email, or phone number.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (name, email, or phone)." }),
      pageSize: Type.Optional(Type.Number({ description: "Max results (default 10, max 30)." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = readString(params, "query");
      if (!query) throw new Error("query is required");
      const pageSize = Math.min(readNumber(params, "pageSize", 10) ?? 10, 30);

      const data = (await runGws(["people", "people", "searchContacts"], {
        params: {
          query,
          pageSize,
          readMask: "names,emailAddresses,phoneNumbers,organizations",
        },
      })) as any;

      return jsonResult({
        contacts: (data.results || []).map((r: any) => extractContact(r.person)),
      });
    },
  };
}
