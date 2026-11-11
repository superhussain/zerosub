import { usePaseo } from "@getpaseo/plugin/client";
import { SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { OPENCODE_LABEL, OPENCODE_PROVIDER } from "../shared/model";
import type { Preferences } from "../shared/preferences";

interface CatalogModel {
  id: string;
  label: string;
  isDefault?: boolean;
  thinkingOptions?: Array<{ id: string; label: string }>;
}

type Catalog =
  | { status: "loading" }
  | { status: "ready"; models: CatalogModel[] }
  | { status: "error"; message: string }
  | { status: "empty" };

/**
 * Where a stopped Claude chat continues when the fork option is on: the destination, and for
 * OpenCode the model and thinking option, read from this host's catalog. Rendered under the fork
 * toggle wherever it appears.
 */
export function ForkDestinationRows({
  values,
  saving,
  onSave,
}: {
  values: Preferences;
  saving: boolean;
  onSave(patch: Partial<Preferences>): void;
}) {
  const paseo = usePaseo();
  const [catalog, setCatalog] = useState<Catalog>({ status: "loading" });
  useEffect(() => {
    let live = true;
    paseo.providers
      .listModels(OPENCODE_PROVIDER)
      .then((result) => {
        if (live) setCatalog((result.models ?? []).length > 0 ? { status: "ready", models: result.models ?? [] } : { status: "empty" });
      })
      .catch((error: unknown) => {
        if (live) setCatalog({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [paseo]);

  const enabled = !saving && values.forkOtherProvider && values.autoSwitch;
  const rows = [
    <SettingsSelect
      key="destination"
      label="Fork a stopped Claude chat to"
      hint="Applies when every Claude account is out. ChatGPT uses the account with the most room left."
      value={values.claudeForkDestination}
      options={[
        { label: "ChatGPT", value: "codex" },
        { label: OPENCODE_LABEL, value: "opencode" },
      ]}
      disabled={!enabled}
      onValueChange={(claudeForkDestination) => onSave({ claudeForkDestination })}
    />,
  ];
  if (values.claudeForkDestination !== "opencode") return <>{rows}</>;

  if (catalog.status !== "ready") {
    const hint =
      catalog.status === "loading"
        ? "Loading this host's OpenCode catalog…"
        : catalog.status === "empty"
          ? "This host's OpenCode reported no models."
          : `Couldn't read this host's OpenCode models: ${catalog.message}`;
    return (
      <>
        {rows}
        <SettingsRow label="OpenCode model" hint={hint} />
      </>
    );
  }

  const model = values.forkOpenCodeModel
    ? catalog.models.find((entry) => entry.id === values.forkOpenCodeModel)
    : catalog.models.find((entry) => entry.isDefault);
  rows.push(
    <SettingsSelect
      key="model"
      label="OpenCode model"
      hint={
        values.forkOpenCodeModel && !model
          ? "That model is no longer in this host's catalog; pick another."
          : "Used by the OpenCode fork agent on this host. Empty uses the host's default."
      }
      value={values.forkOpenCodeModel}
      options={[{ label: "Host default", value: "" }, ...catalog.models.map((entry) => ({ label: entry.label, value: entry.id }))]}
      disabled={!enabled}
      onValueChange={(forkOpenCodeModel) => {
        // A thinking option the newly picked model doesn't offer can't stand.
        const next = forkOpenCodeModel ? catalog.models.find((entry) => entry.id === forkOpenCodeModel) : undefined;
        const keep = next?.thinkingOptions?.some((option) => option.id === values.forkOpenCodeThinking);
        onSave(keep ? { forkOpenCodeModel } : { forkOpenCodeModel, forkOpenCodeThinking: "" });
      }}
    />,
  );
  if (values.forkOpenCodeModel) {
    rows.push(
      <SettingsSelect
        key="thinking"
        label="OpenCode thinking"
        hint="How hard the model thinks on the fork. Empty uses the model's default."
        value={values.forkOpenCodeThinking}
        options={[
          { label: "Model default", value: "" },
          ...(model?.thinkingOptions ?? []).map((option) => ({ label: option.label, value: option.id })),
        ]}
        disabled={!enabled}
        onValueChange={(forkOpenCodeThinking) => onSave({ forkOpenCodeThinking })}
      />,
    );
  }
  return <>{rows}</>;
}
