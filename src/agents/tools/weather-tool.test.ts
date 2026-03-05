import { beforeEach, describe, expect, it, vi } from "vitest";

const { guardedFetchMock } = vi.hoisted(() => ({
  guardedFetchMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  withWebToolsNetworkGuard: guardedFetchMock,
}));

import { createWeatherTool } from "./weather-tool.js";

type GuardedFetchParams = {
  method?: string;
  url: string;
  timeoutSeconds?: number;
};

type GuardedFetchRun = (params: { response: Response; finalUrl: string }) => Promise<unknown>;

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("weather tool", () => {
  beforeEach(() => {
    guardedFetchMock.mockReset();
    guardedFetchMock.mockImplementation(
      async (params: GuardedFetchParams, run: GuardedFetchRun) => {
        if (params.url.includes("geocoding-api.open-meteo.com")) {
          return run({
            response: jsonResponse({
              results: [
                {
                  name: "San Francisco",
                  admin1: "California",
                  country: "United States",
                  country_code: "US",
                  latitude: 37.7749,
                  longitude: -122.4194,
                  timezone: "America/Los_Angeles",
                },
              ],
            }),
            finalUrl: params.url,
          });
        }
        if (params.url.includes("api.open-meteo.com")) {
          return run({
            response: jsonResponse({
              current: {
                time: "2026-03-07T21:00",
                temperature_2m: 58.2,
                apparent_temperature: 57.1,
                relative_humidity_2m: 72,
                precipitation: 0,
                weather_code: 2,
                wind_speed_10m: 8.4,
                wind_direction_10m: 250,
              },
              daily: {
                time: ["2026-03-07", "2026-03-08", "2026-03-09"],
                weather_code: [2, 3, 61],
                temperature_2m_max: [61.2, 59.8, 57.4],
                temperature_2m_min: [51.3, 49.7, 47.8],
                precipitation_probability_max: [10, 20, 65],
              },
            }),
            finalUrl: params.url,
          });
        }
        throw new Error(`Unexpected URL: ${params.url}`);
      },
    );
  });

  it("returns current weather plus a short forecast", async () => {
    const tool = createWeatherTool();
    const result = await tool.execute("call-1", {
      location: "San Francisco",
      days: 2,
    });

    expect(result.details).toMatchObject({
      ok: true,
      source: "open-meteo",
      requestedLocation: "San Francisco",
      location: {
        name: "San Francisco, California, United States",
        countryCode: "US",
      },
      units: {
        temperature: "F",
        windSpeed: "mph",
        precipitation: "in",
      },
      current: {
        condition: "Partly cloudy",
        temperature: 58.2,
        feelsLike: 57.1,
      },
    });
    expect((result.details as { forecast?: unknown[] }).forecast).toHaveLength(2);
    expect(guardedFetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches repeated lookups for the same request", async () => {
    const tool = createWeatherTool();
    await tool.execute("call-2", { location: "San Francisco", units: "fahrenheit", days: 2 });
    const result = await tool.execute("call-3", {
      location: "San Francisco",
      units: "fahrenheit",
      days: 2,
    });

    expect(guardedFetchMock).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({
      ok: true,
      cached: true,
    });
  });

  it("returns a structured error when the location cannot be resolved", async () => {
    guardedFetchMock.mockReset();
    guardedFetchMock.mockImplementation(
      async (params: GuardedFetchParams, run: GuardedFetchRun) => {
        if (params.url.includes("geocoding-api.open-meteo.com")) {
          return run({
            response: jsonResponse({ results: [] }),
            finalUrl: params.url,
          });
        }
        throw new Error(`Unexpected URL: ${params.url}`);
      },
    );

    const tool = createWeatherTool();
    const result = await tool.execute("call-4", {
      location: "Atlantis",
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: "weather_lookup_failed",
      requestedLocation: "Atlantis",
    });
    expect((result.details as { message?: string }).message).toContain("No weather location match");
  });
});
