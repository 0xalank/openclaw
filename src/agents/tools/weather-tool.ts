import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { withWebToolsNetworkGuard } from "./web-guarded-fetch.js";
import type { CacheEntry } from "./web-shared.js";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

const WEATHER_UNITS = ["auto", "celsius", "fahrenheit"] as const;
const WEATHER_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WEATHER_TOOL_TIMEOUT_SECONDS = resolveTimeoutSeconds(undefined, DEFAULT_TIMEOUT_SECONDS);
const WEATHER_TOOL_CACHE_TTL_MS = resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES);
const WEATHER_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const WEATHER_ERROR_DETAIL_MAX_BYTES = 24_000;
const DEFAULT_FORECAST_DAYS = 3;
const MAX_FORECAST_DAYS = 5;
const FAHRENHEIT_COUNTRY_CODES = new Set(["US", "BS", "BZ", "KY", "LR", "PW", "FM", "MH"]);

const WeatherToolSchema = Type.Object({
  location: Type.String({
    description: "City, region, or place name to resolve via geocoding.",
  }),
  units: Type.Optional(
    stringEnum(WEATHER_UNITS, {
      description:
        'Temperature units: "auto" picks Fahrenheit for US-like locales and Celsius otherwise.',
      default: "auto",
    }),
  ),
  days: Type.Optional(
    Type.Number({
      description: `How many forecast days to include (1-${MAX_FORECAST_DAYS}).`,
      minimum: 1,
      maximum: MAX_FORECAST_DAYS,
    }),
  ),
});

type WeatherUnits = "celsius" | "fahrenheit";

type GeocodingResult = {
  name?: string;
  admin1?: string;
  country?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
};

type WeatherApiResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
};

function clampForecastDays(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FORECAST_DAYS;
  }
  return Math.min(MAX_FORECAST_DAYS, Math.max(1, Math.trunc(value)));
}

function resolveWeatherUnits(requested: string | undefined, countryCode?: string): WeatherUnits {
  const normalized = requested?.trim().toLowerCase();
  if (normalized === "celsius") {
    return "celsius";
  }
  if (normalized === "fahrenheit") {
    return "fahrenheit";
  }
  if (countryCode && FAHRENHEIT_COUNTRY_CODES.has(countryCode.toUpperCase())) {
    return "fahrenheit";
  }
  return "celsius";
}

function temperatureUnitLabel(units: WeatherUnits): "C" | "F" {
  return units === "fahrenheit" ? "F" : "C";
}

function windUnitLabel(units: WeatherUnits): "mph" | "km/h" {
  return units === "fahrenheit" ? "mph" : "km/h";
}

function precipitationUnitLabel(units: WeatherUnits): "in" | "mm" {
  return units === "fahrenheit" ? "in" : "mm";
}

function formatNumber(value: unknown, digits = 1): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatLocation(result: GeocodingResult): string {
  return [result.name, result.admin1, result.country]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(", ");
}

function weatherCodeDescription(code: number | undefined): string {
  switch (code) {
    case 0:
      return "Clear sky";
    case 1:
      return "Mostly clear";
    case 2:
      return "Partly cloudy";
    case 3:
      return "Overcast";
    case 45:
      return "Fog";
    case 48:
      return "Depositing rime fog";
    case 51:
      return "Light drizzle";
    case 53:
      return "Moderate drizzle";
    case 55:
      return "Dense drizzle";
    case 56:
      return "Light freezing drizzle";
    case 57:
      return "Dense freezing drizzle";
    case 61:
      return "Slight rain";
    case 63:
      return "Moderate rain";
    case 65:
      return "Heavy rain";
    case 66:
      return "Light freezing rain";
    case 67:
      return "Heavy freezing rain";
    case 71:
      return "Slight snow";
    case 73:
      return "Moderate snow";
    case 75:
      return "Heavy snow";
    case 77:
      return "Snow grains";
    case 80:
      return "Rain showers";
    case 81:
      return "Moderate rain showers";
    case 82:
      return "Violent rain showers";
    case 85:
      return "Snow showers";
    case 86:
      return "Heavy snow showers";
    case 95:
      return "Thunderstorm";
    case 96:
      return "Thunderstorm with slight hail";
    case 99:
      return "Thunderstorm with heavy hail";
    default:
      return "Unknown conditions";
  }
}

async function parseJsonResponse<T>(response: Response, url: string): Promise<T> {
  if (!response.ok) {
    const detail = await readResponseText(response, { maxBytes: WEATHER_ERROR_DETAIL_MAX_BYTES });
    const message = detail.text.trim() || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Weather request failed for ${url}: ${message}`);
  }
  return (await response.json()) as T;
}

async function fetchGeocoding(location: string): Promise<GeocodingResult> {
  const url = new URL(WEATHER_GEOCODING_URL);
  url.searchParams.set("name", location);
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  return withWebToolsNetworkGuard(
    {
      url: url.toString(),
      timeoutSeconds: WEATHER_TOOL_TIMEOUT_SECONDS,
    },
    async ({ response }) => {
      const payload = (await parseJsonResponse<{ results?: GeocodingResult[] }>(
        response,
        url.toString(),
      )) as { results?: GeocodingResult[] };
      const match = Array.isArray(payload.results)
        ? payload.results.find(
            (entry) =>
              typeof entry.latitude === "number" &&
              Number.isFinite(entry.latitude) &&
              typeof entry.longitude === "number" &&
              Number.isFinite(entry.longitude),
          )
        : undefined;
      if (!match) {
        throw new Error(`No weather location match found for "${location}"`);
      }
      return match;
    },
  );
}

async function fetchForecast(params: {
  latitude: number;
  longitude: number;
  units: WeatherUnits;
  days: number;
}): Promise<WeatherApiResponse> {
  const url = new URL(WEATHER_FORECAST_URL);
  url.searchParams.set("latitude", String(params.latitude));
  url.searchParams.set("longitude", String(params.longitude));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", String(params.days));
  url.searchParams.set("temperature_unit", params.units);
  url.searchParams.set("windspeed_unit", params.units === "fahrenheit" ? "mph" : "kmh");
  url.searchParams.set("precipitation_unit", params.units === "fahrenheit" ? "inch" : "mm");
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
  );
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
    ].join(","),
  );

  return withWebToolsNetworkGuard(
    {
      url: url.toString(),
      timeoutSeconds: WEATHER_TOOL_TIMEOUT_SECONDS,
    },
    async ({ response }) => parseJsonResponse<WeatherApiResponse>(response, url.toString()),
  );
}

function buildWeatherPayload(params: {
  requestedLocation: string;
  resolvedLocation: GeocodingResult;
  forecast: WeatherApiResponse;
  units: WeatherUnits;
  days: number;
}): Record<string, unknown> {
  const { requestedLocation, resolvedLocation, forecast, units, days } = params;
  const current = forecast.current;
  const daily = forecast.daily;
  const times = Array.isArray(daily?.time) ? daily.time : [];
  const dayPayload = times.slice(0, days).map((date, index) => ({
    date,
    condition: weatherCodeDescription(daily?.weather_code?.[index]),
    high: formatNumber(daily?.temperature_2m_max?.[index]),
    low: formatNumber(daily?.temperature_2m_min?.[index]),
    precipitationProbabilityMax: daily?.precipitation_probability_max?.[index] ?? undefined,
  }));

  return {
    ok: true,
    source: "open-meteo",
    requestedLocation,
    location: {
      name: formatLocation(resolvedLocation),
      latitude: formatNumber(resolvedLocation.latitude, 4),
      longitude: formatNumber(resolvedLocation.longitude, 4),
      timezone: resolvedLocation.timezone,
      countryCode: resolvedLocation.country_code,
    },
    units: {
      temperature: temperatureUnitLabel(units),
      windSpeed: windUnitLabel(units),
      precipitation: precipitationUnitLabel(units),
    },
    current: {
      observedAt: current?.time,
      condition: weatherCodeDescription(current?.weather_code),
      temperature: formatNumber(current?.temperature_2m),
      feelsLike: formatNumber(current?.apparent_temperature),
      humidityPercent: current?.relative_humidity_2m ?? undefined,
      precipitation: formatNumber(current?.precipitation),
      windSpeed: formatNumber(current?.wind_speed_10m),
      windDirectionDegrees: formatNumber(current?.wind_direction_10m, 0),
    },
    forecast: dayPayload,
  };
}

export function createWeatherTool(): AnyAgentTool {
  return {
    label: "Weather",
    name: "weather",
    description:
      "Get current weather and a short forecast for a location. Uses Open-Meteo geocoding and forecast APIs and does not require a separate weather API key.",
    parameters: WeatherToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const location = readStringParam(params, "location", { required: true });
      const requestedUnits = readStringParam(params, "units");
      const days = clampForecastDays(readNumberParam(params, "days", { integer: true }));
      const cacheKey = normalizeCacheKey(`${location}::${requestedUnits ?? "auto"}::${days}`);
      const cached = readCache(WEATHER_CACHE, cacheKey);
      if (cached) {
        return jsonResult({
          ...cached.value,
          cached: true,
        });
      }

      try {
        const resolvedLocation = await fetchGeocoding(location);
        const units = resolveWeatherUnits(requestedUnits, resolvedLocation.country_code);
        const forecast = await fetchForecast({
          latitude: resolvedLocation.latitude ?? 0,
          longitude: resolvedLocation.longitude ?? 0,
          units,
          days,
        });
        const payload = buildWeatherPayload({
          requestedLocation: location,
          resolvedLocation,
          forecast,
          units,
          days,
        });
        writeCache(WEATHER_CACHE, cacheKey, payload, WEATHER_TOOL_CACHE_TTL_MS);
        return jsonResult(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({
          ok: false,
          error: "weather_lookup_failed",
          message,
          requestedLocation: location,
        });
      }
    },
  };
}
