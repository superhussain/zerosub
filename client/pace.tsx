import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { PACE_GATE_PERCENT, type PaceView } from "../shared/model";
import { useText } from "./ui";

type Theme = PluginHostProps["theme"];

export interface PaceCopy {
  fiveHour: string;
  pending: string | null;
  weekly: string | null;
  standing: "ahead" | "behind" | "on" | null;
  held: string | null;
}

const r = Math.round;

/** The words under an account's pacing bars. */
export function describePace(pace: PaceView): PaceCopy {
  const { fiveHourUsed, fiveHourProjected, pendingFiveHour, weeklyUsed, pendingWeekly, weekElapsed, pending, gated } = pace;
  let standing: PaceCopy["standing"] = null;
  if (weeklyUsed !== null && weekElapsed !== null) {
    const used = r(weeklyUsed + pendingWeekly);
    const gone = r(weekElapsed);
    standing = used > gone ? "ahead" : used < gone ? "behind" : "on";
  }
  return {
    fiveHour:
      fiveHourUsed === null
        ? `No 5-hour reading yet. Pacing counts it as ${r(fiveHourProjected)}%.`
        : `${r(fiveHourUsed)}% now · ${r(fiveHourProjected)}% in an hour`,
    pending:
      pending === 0
        ? null
        : `Counts ${pending} new agent${pending === 1 ? "" : "s"} the reading doesn't show yet (+${r(pendingFiveHour)}% 5-hour, +${r(pendingWeekly)}% weekly)`,
    weekly:
      weeklyUsed === null
        ? null
        : weekElapsed === null
          ? `${r(weeklyUsed)}% used`
          : `${r(weeklyUsed)}% used · ${r(weekElapsed)}% of the week gone · ${standing === "ahead" ? "ahead of" : standing === "behind" ? "behind" : "on"} pace`,
    standing,
    held: gated
      ? `Pacing holds it back: new agents start on other accounts first while it is projected at or past ${PACE_GATE_PERCENT}% of its 5-hour limit.`
      : null,
  };
}

/** A thin bar of stacked fills, widest first, with an optional tick. */
function PaceBar({
  theme,
  color,
  fills,
  tick,
  label,
  now,
}: {
  theme: Theme;
  color: string;
  fills: Array<[percent: number, opacity: number]>;
  tick: number | null;
  label: string;
  now: number;
}) {
  const colors = theme.colors;
  return (
    <View style={{ height: 12, position: "relative" }}>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.min(100, now)) }}
        style={{ height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden", marginTop: 3 }}
      >
        {fills.map(([percent, opacity], index) => (
          <View
            key={index}
            style={{ position: "absolute", left: 0, top: 0, height: 6, borderRadius: 3, width: `${Math.min(100, percent)}%`, backgroundColor: color, opacity }}
          />
        ))}
      </View>
      {tick === null ? null : (
        <View style={{ position: "absolute", left: `${tick}%`, top: 0, width: 2, height: 12, marginLeft: -1, backgroundColor: colors.foreground }} />
      )}
    </View>
  );
}

function PaceRow({ theme, label, value }: { theme: Theme; label: string; value: string }) {
  const colors = theme.colors;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: colors.foreground, fontSize: 12 }}>{value}</Text>
    </View>
  );
}

/** How pacing reads an account: the 5-hour projection against the gate, the weekly use, and pending agents. */
export function PaceSection({ theme, pace }: { theme: Theme; pace: PaceView }) {
  const text = useText(theme);
  const colors = theme.colors;
  const copy = describePace(pace);
  const { fiveHourUsed, fiveHourProjected, pendingFiveHour, weeklyUsed, pendingWeekly, weekElapsed } = pace;
  return (
    <View style={{ gap: 6 }}>
      <Text style={[text.small, { fontWeight: "600" }]}>Pacing</Text>
      <PaceRow theme={theme} label={`5-hour an hour ahead · gate ${PACE_GATE_PERCENT}%`} value={copy.fiveHour} />
      <PaceBar
        theme={theme}
        color={pace.gated ? colors.statusWarning : colors.statusSuccess}
        fills={[
          [fiveHourProjected, 0.2],
          [fiveHourProjected - pendingFiveHour, 0.45],
          [fiveHourUsed ?? 0, 1],
        ]}
        tick={PACE_GATE_PERCENT}
        label="5-hour use projected an hour ahead"
        now={fiveHourProjected}
      />
      {copy.pending ? <Text style={text.small}>{copy.pending}</Text> : null}
      {copy.weekly && weeklyUsed !== null ? (
        <>
          <PaceRow theme={theme} label="Weekly pace" value={copy.weekly} />
          <PaceBar
            theme={theme}
            color={copy.standing === "ahead" ? colors.statusWarning : colors.statusSuccess}
            fills={[
              [weeklyUsed + pendingWeekly, 0.2],
              [weeklyUsed, 1],
            ]}
            tick={weekElapsed}
            label="Weekly use against the week gone"
            now={weeklyUsed + pendingWeekly}
          />
        </>
      ) : null}
      {copy.held ? <Text style={text.warning}>{copy.held}</Text> : null}
    </View>
  );
}
