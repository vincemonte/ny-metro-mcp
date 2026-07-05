import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALERT_FEEDS,
  LIRR_FEED,
  fetchJsonFeed,
  fetchProtobufFeed,
  subwayFeedUrlsForRoutes,
} from "@/lib/feeds";
import { lirrStops, resolveStation, subwayStops } from "@/lib/stations";
import { formatDeparture, formatEt, nowEpoch } from "@/lib/format";
import {
  findTrains,
  firstLastTrains,
  fmtMin,
  nowMinutesNy,
  parseDate,
  parseHhMm,
  todayNy,
} from "@/lib/schedule";

/* ------------------------------ helpers ------------------------------ */

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const lirrNameById = () => new Map(lirrStops.map((s) => [s.id, s.name]));
const subwayNameById = () => new Map(subwayStops.map((s) => [s.id, s.name]));

/* ------------------------------- tools ------------------------------- */

export function registerTools(server: McpServer) {
  /* ---------------------- LIRR: next trains ---------------------- */
  server.tool(
    "lirr_next_trains",
    "Get upcoming LIRR (Long Island Rail Road) departures between two stations, using " +
      "realtime data (includes delays). Station names can be approximate — e.g. 'Penn', " +
      "'Grand Central', 'Woodside', 'Port Washington'. Returns scheduled/expected departure " +
      "and arrival times in Eastern Time. If a name is ambiguous the error message lists " +
      "candidate stations to retry with.",
    {
      origin: z.string().describe("Departure station name, e.g. 'Penn Station'"),
      destination: z.string().describe("Arrival station name, e.g. 'Port Washington'"),
      limit: z.number().int().min(1).max(10).default(5).describe("Max trains to return"),
    },
    async ({ origin, destination, limit }) => {
      try {
        const from = resolveStation(origin, lirrStops, "LIRR");
        const to = resolveStation(destination, lirrStops, "LIRR");
        if (from.id === to.id) return text("Origin and destination resolve to the same station.");

        const feed = await fetchProtobufFeed(LIRR_FEED);
        const names = lirrNameById();
        const now = nowEpoch();

        const trains: {
          departs: number;
          arrives?: number;
          delayMin: number;
          finalStop: string;
        }[] = [];

        for (const entity of feed.entity) {
          const tu = entity.tripUpdate;
          if (!tu?.stopTimeUpdate?.length) continue;
          const stus = tu.stopTimeUpdate;
          const oIdx = stus.findIndex((s) => s.stopId === from.id);
          if (oIdx === -1) continue;
          const dIdx = stus.findIndex((s, i) => i > oIdx && s.stopId === to.id);
          if (dIdx === -1) continue;

          const dep = stus[oIdx].departure ?? stus[oIdx].arrival;
          const departs = Number(dep?.time ?? 0);
          if (!departs || departs < now - 60) continue;

          const arr = stus[dIdx].arrival ?? stus[dIdx].departure;
          const lastStopId = stus[stus.length - 1]?.stopId ?? "";
          trains.push({
            departs,
            arrives: arr?.time ? Number(arr.time) : undefined,
            delayMin: Math.round(Number(dep?.delay ?? 0) / 60),
            finalStop: names.get(lastStopId) ?? lastStopId,
          });
        }

        trains.sort((a, b) => a.departs - b.departs);
        const next = trains.slice(0, limit);
        if (next.length === 0) {
          return text(
            `No upcoming trains found from ${from.name} to ${to.name} in the realtime feed. ` +
              `The feed only covers roughly the next few hours of active/scheduled trips.`
          );
        }

        const lines = next.map((t, i) => {
          const delay =
            t.delayMin > 1 ? ` — running ~${t.delayMin} min late` : t.delayMin < -1 ? " — early" : "";
          const arrival = t.arrives ? `, arrives ${to.name} ${formatEt(t.arrives)} ET` : "";
          return `${i + 1}. Departs ${from.name} ${formatDeparture(t.departs)}${arrival} (train toward ${t.finalStop})${delay}`;
        });
        return text(`Next LIRR trains, ${from.name} → ${to.name}:\n${lines.join("\n")}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  /* --------------------- Subway: arrivals board --------------------- */
  server.tool(
    "subway_arrivals",
    "Get realtime NYC subway arrivals at a station, grouped by direction. Station names can " +
      "be approximate (e.g. 'Astoria Ditmars', 'Times Sq'). Optionally filter to specific " +
      "routes (e.g. ['N','W']). Times are Eastern Time. If the station name is ambiguous " +
      "the error message lists candidates to retry with.",
    {
      station: z.string().describe("Station name, e.g. '30 Av' or 'Union Sq'"),
      routes: z
        .array(z.string())
        .optional()
        .describe("Optional route filter, e.g. ['N','W']. Defaults to all routes at the station."),
      limit: z.number().int().min(1).max(12).default(6).describe("Max arrivals per direction"),
    },
    async ({ station, routes, limit }) => {
      try {
        const stop = resolveStation(station, subwayStops, "subway");
        const wanted = (routes?.length ? routes : stop.routes).map((r) => r.toUpperCase());
        const urls = subwayFeedUrlsForRoutes(wanted);
        const feeds = await Promise.all(urls.map(fetchProtobufFeed));
        const names = subwayNameById();
        const now = nowEpoch();

        type Arrival = { time: number; route: string; toward: string };
        const byDirection: Record<"N" | "S", Arrival[]> = { N: [], S: [] };

        for (const feed of feeds) {
          for (const entity of feed.entity) {
            const tu = entity.tripUpdate;
            if (!tu?.stopTimeUpdate?.length) continue;
            const route = (tu.trip?.routeId ?? "").toUpperCase();
            if (wanted.length && !wanted.includes(route)) continue;

            for (const stu of tu.stopTimeUpdate) {
              const sid = stu.stopId ?? "";
              if (!sid.startsWith(stop.id)) continue;
              const dir = sid.endsWith("N") ? "N" : sid.endsWith("S") ? "S" : null;
              if (!dir) continue;
              const t = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);
              if (!t || t < now - 30) continue;
              const lastStopId = (tu.stopTimeUpdate[tu.stopTimeUpdate.length - 1]?.stopId ?? "").replace(
                /[NS]$/,
                ""
              );
              byDirection[dir].push({
                time: t,
                route,
                toward: names.get(lastStopId) ?? lastStopId,
              });
            }
          }
        }

        const fmtDir = (dir: "N" | "S") => {
          const arrivals = byDirection[dir].sort((a, b) => a.time - b.time).slice(0, limit);
          if (arrivals.length === 0) return `  (no upcoming trains in feed)`;
          return arrivals
            .map((a) => `  ${a.route} to ${a.toward} — ${formatDeparture(a.time)}`)
            .join("\n");
        };

        return text(
          `Arrivals at ${stop.name} (${stop.routes.join("/")})\n` +
            `Northbound platform:\n${fmtDir("N")}\n` +
            `Southbound platform:\n${fmtDir("S")}\n` +
            `Note: N/S are GTFS platform directions (roughly uptown/Bronx-Queens-bound vs downtown/Brooklyn-bound); ` +
            `use the 'to <terminal>' destination to disambiguate.`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  /* ------------------------- Service alerts ------------------------- */
  server.tool(
    "service_alerts",
    "Get current MTA service alerts for the subway or LIRR — delays, service changes, " +
      "planned work. Optionally filter by route (subway line like 'N', or LIRR branch " +
      "name substring like 'Port Washington'). This is the best tool for 'is my line ok?' " +
      "and 'should I leave early?' questions.",
    {
      system: z.enum(["subway", "lirr"]).describe("Which system's alerts to fetch"),
      route: z
        .string()
        .optional()
        .describe("Optional filter: subway route id (e.g. 'N') or LIRR branch substring"),
      limit: z.number().int().min(1).max(25).default(10).describe("Max alerts to return"),
    },
    async ({ system, route, limit }) => {
      try {
        const data = await fetchJsonFeed<{
          entity?: {
            alert?: {
              informed_entity?: { route_id?: string }[];
              header_text?: { translation?: { text?: string; language?: string }[] };
              description_text?: { translation?: { text?: string; language?: string }[] };
              active_period?: { start?: number; end?: number }[];
            };
          }[];
        }>(ALERT_FEEDS[system]);

        const englishText = (
          field?: { translation?: { text?: string; language?: string }[] }
        ): string =>
          field?.translation?.find((t) => !t.language || t.language.startsWith("en"))?.text ?? "";

        const wanted = route?.toLowerCase();
        const alerts = (data.entity ?? [])
          .map((e) => e.alert)
          .filter((a): a is NonNullable<typeof a> => Boolean(a))
          .filter((a) => {
            if (!wanted) return true;
            return (a.informed_entity ?? []).some((ie) =>
              (ie.route_id ?? "").toLowerCase().includes(wanted)
            );
          })
          .slice(0, limit)
          .map((a, i) => {
            const header = englishText(a.header_text) || "(no header)";
            const desc = englishText(a.description_text);
            const routesAffected = [
              ...new Set((a.informed_entity ?? []).map((ie) => ie.route_id).filter(Boolean)),
            ].join(", ");
            const parts = [`${i + 1}. ${header}`];
            if (routesAffected) parts.push(`   Routes: ${routesAffected}`);
            if (desc) parts.push(`   ${desc.length > 400 ? desc.slice(0, 400) + "…" : desc}`);
            return parts.join("\n");
          });

        if (alerts.length === 0) {
          return text(
            `No current ${system.toUpperCase()} alerts${route ? ` matching "${route}"` : ""}.`
          );
        }
        return text(`Current ${system.toUpperCase()} alerts:\n${alerts.join("\n\n")}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  /* ---------------- LIRR: scheduled timetable (plan ahead) ---------------- */
  server.tool(
    "lirr_schedule",
    "Get *scheduled* LIRR trains between two stations for any date — today, tomorrow, next " +
      "Saturday, etc. Uses the official static timetable (no realtime delays), so this is the " +
      "right tool for planning ahead; use lirr_next_trains for live 'right now' departures. " +
      "Supports 'depart after' and 'arrive by' queries. Station names can be approximate.",
    {
      origin: z.string().describe("Departure station name, e.g. 'Penn Station'"),
      destination: z.string().describe("Arrival station name, e.g. 'Port Washington'"),
      date: z
        .string()
        .optional()
        .describe("Date as YYYY-MM-DD in New York time. Defaults to today."),
      depart_after: z
        .string()
        .optional()
        .describe(
          "Earliest departure, 24-hour HH:MM (e.g. '18:30'). Defaults to the current time " +
            "if date is today, otherwise start of day."
        ),
      arrive_by: z
        .string()
        .optional()
        .describe(
          "If set (24-hour HH:MM), returns the latest trains that still arrive by this time — " +
            "ideal for 'I need to be there by 9am' questions."
        ),
      limit: z.number().int().min(1).max(15).default(6).describe("Max trains to return"),
    },
    async ({ origin, destination, date, depart_after, arrive_by, limit }) => {
      try {
        const from = resolveStation(origin, lirrStops, "LIRR");
        const to = resolveStation(destination, lirrStops, "LIRR");
        if (from.id === to.id) return text("Origin and destination resolve to the same station.");

        const day = date ?? todayNy();
        parseDate(day); // validate early for a clean error message
        const departAfterMin =
          depart_after !== undefined
            ? parseHhMm(depart_after)
            : day === todayNy() && arrive_by === undefined
              ? nowMinutesNy()
              : 0;
        const arriveByMin = arrive_by !== undefined ? parseHhMm(arrive_by) : undefined;

        const names = lirrNameById();
        const trains = findTrains({
          originId: from.id,
          destId: to.id,
          date: day,
          departAfterMin,
          arriveByMin,
          limit,
        });

        if (trains.length === 0) {
          return text(
            `No scheduled trains found from ${from.name} to ${to.name} on ${day}` +
              `${arrive_by ? ` arriving by ${arrive_by}` : ""}` +
              `${depart_after ? ` departing after ${depart_after}` : ""}. ` +
              `Note: the schedule data only covers the date range of the published GTFS ` +
              `(roughly the next few months), and some station pairs require a transfer at ` +
              `Jamaica — this tool only finds direct (one-seat) trains.`
          );
        }

        const lines = trains.map((t, i) => {
          const dur = t.arr - t.dep;
          const lateNight = t.dep >= 1440 ? " (after midnight)" : "";
          return (
            `${i + 1}. Departs ${fmtMin(t.dep)}${lateNight} → arrives ${to.name} ${fmtMin(t.arr)}` +
            ` (${dur} min, ${t.stops === 0 ? "no intermediate stops shown" : `${t.stops} stops`},` +
            ` train toward ${names.get(t.finalStopId) ?? t.finalStopId})`
          );
        });
        return text(
          `Scheduled LIRR trains, ${from.name} → ${to.name}, ${day}` +
            `${arrive_by ? ` (arriving by ${arrive_by})` : ""}:\n${lines.join("\n")}\n` +
            `Note: scheduled times only — check lirr_next_trains or service_alerts for ` +
            `day-of disruptions. Direct trains only; some trips require changing at Jamaica.`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  /* ---------------- LIRR: first and last train of the day ---------------- */
  server.tool(
    "lirr_first_last_train",
    "Get the first and last scheduled LIRR trains between two stations for a given service " +
      "day. Perfect for 'when's the last train home tonight?' or 'how early can I get in on " +
      "Saturday?'. A 'last train' departing after midnight is reported with a note, since it " +
      "belongs to the previous service day. Direct trains only.",
    {
      origin: z.string().describe("Departure station name"),
      destination: z.string().describe("Arrival station name"),
      date: z
        .string()
        .optional()
        .describe(
          "Service date as YYYY-MM-DD (New York time). Defaults to today — so 'tonight's " +
            "last train' just after midnight may require passing yesterday's date."
        ),
    },
    async ({ origin, destination, date }) => {
      try {
        const from = resolveStation(origin, lirrStops, "LIRR");
        const to = resolveStation(destination, lirrStops, "LIRR");
        if (from.id === to.id) return text("Origin and destination resolve to the same station.");

        const day = date ?? todayNy();
        parseDate(day);
        const result = firstLastTrains(from.id, to.id, day);
        if (!result) {
          return text(
            `No direct scheduled trains from ${from.name} to ${to.name} on ${day}. ` +
              `This pair may require a transfer at Jamaica, or the date may be outside the ` +
              `published schedule.`
          );
        }
        const names = lirrNameById();
        const fmt = (t: (typeof result)["first"], label: string) =>
          `${label}: departs ${fmtMin(t.dep)}${t.dep >= 1440 ? " (after midnight, i.e. early next calendar day)" : ""}, ` +
          `arrives ${fmtMin(t.arr)} (toward ${names.get(t.finalStopId) ?? t.finalStopId})`;
        return text(
          `${from.name} → ${to.name}, service day ${day}:\n` +
            `${fmt(result.first, "First train")}\n${fmt(result.last, "Last train")}`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  /* ------------------ Planned service changes (look ahead) ------------------ */
  server.tool(
    "planned_service_changes",
    "Get *upcoming* planned MTA service changes (weekend work, scheduled track outages, " +
      "planned suspensions) for the subway or LIRR over the next N days. Complements " +
      "service_alerts, which focuses on what's happening right now. Use this when someone is " +
      "planning a trip for later this week/weekend.",
    {
      system: z.enum(["subway", "lirr"]).describe("Which system to check"),
      route: z
        .string()
        .optional()
        .describe("Optional filter: subway route id (e.g. 'N') or LIRR branch substring"),
      days_ahead: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(14)
        .describe("How many days ahead to look"),
      limit: z.number().int().min(1).max(25).default(10).describe("Max alerts to return"),
    },
    async ({ system, route, days_ahead, limit }) => {
      try {
        const data = await fetchJsonFeed<{
          entity?: {
            alert?: {
              informed_entity?: { route_id?: string }[];
              header_text?: { translation?: { text?: string; language?: string }[] };
              active_period?: { start?: number; end?: number }[];
            };
          }[];
        }>(ALERT_FEEDS[system]);

        const englishText = (
          field?: { translation?: { text?: string; language?: string }[] }
        ): string =>
          field?.translation?.find((t) => !t.language || t.language.startsWith("en"))?.text ?? "";

        const now = nowEpoch();
        const horizon = now + days_ahead * 86_400;
        const wanted = route?.toLowerCase();

        const upcoming = (data.entity ?? [])
          .map((e) => e.alert)
          .filter((a): a is NonNullable<typeof a> => Boolean(a))
          .map((a) => {
            // Future periods that start within the horizon.
            const periods = (a.active_period ?? []).filter(
              (p) => (p.start ?? 0) > now && (p.start ?? 0) <= horizon
            );
            return { alert: a, periods };
          })
          .filter(({ alert: a, periods }) => {
            if (periods.length === 0) return false;
            if (!wanted) return true;
            return (a.informed_entity ?? []).some((ie) =>
              (ie.route_id ?? "").toLowerCase().includes(wanted)
            );
          })
          .sort((a, b) => (a.periods[0].start ?? 0) - (b.periods[0].start ?? 0))
          .slice(0, limit)
          .map(({ alert: a, periods }, i) => {
            const header = englishText(a.header_text) || "(no header)";
            const routesAffected = [
              ...new Set((a.informed_entity ?? []).map((ie) => ie.route_id).filter(Boolean)),
            ].join(", ");
            const when = periods
              .slice(0, 3)
              .map((p) => {
                const start = formatDateTimeEt(p.start!);
                const end = p.end ? ` → ${formatDateTimeEt(p.end)}` : "";
                return `${start}${end}`;
              })
              .join("; ");
            const parts = [`${i + 1}. ${header}`, `   When: ${when}`];
            if (routesAffected) parts.push(`   Routes: ${routesAffected}`);
            return parts.join("\n");
          });

        if (upcoming.length === 0) {
          return text(
            `No planned ${system.toUpperCase()} service changes${route ? ` matching "${route}"` : ""} ` +
              `starting in the next ${days_ahead} days. (Ongoing disruptions show up in ` +
              `service_alerts instead.)`
          );
        }
        return text(
          `Planned ${system.toUpperCase()} service changes in the next ${days_ahead} days:\n` +
            upcoming.join("\n\n")
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );
}

const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatDateTimeEt(epochSeconds: number): string {
  return dateTimeFmt.format(new Date(epochSeconds * 1000));
}
