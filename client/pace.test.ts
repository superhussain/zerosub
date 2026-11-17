import { describe, expect, it, vi } from "vitest";
import type { PaceView } from "../shared/model";

// The copy is pure text, but it lives beside react-native views a Node test can't load.
vi.mock("react-native", () => ({ Text: () => null, View: () => null }));

import { describePace } from "./pace";

const main: PaceView = {
  fiveHourUsed: 30,
  fiveHourProjected: 90,
  pendingFiveHour: 0,
  weeklyUsed: 25,
  pendingWeekly: 0,
  weekElapsed: 50,
  pending: 0,
  gated: true,
};
const work: PaceView = {
  fiveHourUsed: 45,
  fiveHourProjected: 76.25,
  pendingFiveHour: 20,
  weeklyUsed: 50,
  pendingWeekly: 4,
  weekElapsed: 85.71,
  pending: 2,
  gated: false,
};

describe("describing pace", () => {
  it("says Main is held back", () => {
    expect(describePace(main)).toEqual({
      fiveHour: "30% now · 90% in an hour",
      pending: null,
      weekly: "25% used · 50% of the week gone · behind pace",
      standing: "behind",
      held:
        "Pacing holds it back: new agents start on other accounts first while it is projected at or past 80% of its 5-hour window\u002E",
    });
  });

  it("counts the agents pending on Work", () => {
    expect(describePace(work)).toMatchObject({
      fiveHour: "45% now · 76% in an hour",
      pending: "Counts 2 new agents the reading doesn't show yet (+20% 5-hour, +4% weekly)",
      weekly: "50% used · 86% of the week gone · behind pace",
      held: null,
    });
  });

  it("says one pending agent in the singular", () => {
    expect(describePace({ ...work, pending: 1, pendingFiveHour: 10, pendingWeekly: 2 }).pending).toBe(
      "Counts 1 new agent the reading doesn't show yet (+10% 5-hour, +2% weekly)",
    );
  });

  it("says so when there is no reading", () => {
    const empty: PaceView = { ...main, fiveHourUsed: null, fiveHourProjected: 50, weeklyUsed: null, weekElapsed: null, gated: false };
    expect(describePace(empty)).toMatchObject({
      fiveHour: "No 5-hour reading yet. Pacing counts it as 50%.",
      weekly: null,
      standing: null,
    });
  });

  it("calls weekly use ahead of pace when it is past the week gone", () => {
    const ahead = describePace({ ...main, weeklyUsed: 60, weekElapsed: 40 });
    expect(ahead.standing).toBe("ahead");
    expect(ahead.weekly).toMatch(/ahead of pace$/);
  });
});
