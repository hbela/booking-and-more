"use client";

import { useTranslations } from "next-intl";
import { fromMinorUnits, toMinorUnits, type Service } from "@/lib/api-client";
import { numberValue, textValue, type FormMode } from "@/lib/catalogue-form";
import { Field } from "./ui/field";
import { Input, Select, Textarea } from "./ui/input";

/** What the currency picker offers. The API accepts any ISO 4217 code. */
const CURRENCIES = ["HUF", "EUR", "USD", "GBP"] as const;

/**
 * One field set, used by both the create panel and the edit panel.
 *
 * This is the fix for the whole class of bug the screens started with, not a
 * tidy-up: eleven of a service's fields had no path to them from the dashboard
 * because create and edit were going to be different code and edit was never
 * written. Sharing the component means a field added here is a field in both
 * places, permanently.
 */

export interface ServiceFormState {
  name: string;
  slug: string;
  description: string;
  durationMinutes: string;
  bufferBeforeMinutes: string;
  bufferAfterMinutes: string;
  price: string;
  currency: string;
  requiresApproval: boolean;
  minimumNoticeMinutes: string;
  maximumAdvanceDays: string;
}

export function serviceStateFrom(service?: Service): ServiceFormState {
  return {
    name: service?.name ?? "",
    // Blank on create: the server derives it from the name, accents and all.
    slug: service?.slug ?? "",
    description: service?.description ?? "",
    durationMinutes: service === undefined ? "30" : String(service.durationMinutes),
    bufferBeforeMinutes: String(service?.bufferBeforeMinutes ?? 0),
    bufferAfterMinutes: String(service?.bufferAfterMinutes ?? 0),
    price:
      service?.priceMinor == null || service.currency == null
        ? ""
        : String(fromMinorUnits(service.priceMinor, service.currency)),
    currency: service?.currency ?? "HUF",
    requiresApproval: service?.requiresApproval ?? false,
    minimumNoticeMinutes:
      service?.minimumNoticeMinutes == null ? "" : String(service.minimumNoticeMinutes),
    maximumAdvanceDays:
      service?.maximumAdvanceDays == null ? "" : String(service.maximumAdvanceDays),
  };
}

export function serviceBodyFrom(state: ServiceFormState, mode: FormMode): Record<string, unknown> {
  const price = state.price.trim();

  return {
    name: state.name.trim(),
    slug: textValue(mode, state.slug),
    description: textValue(mode, state.description),
    durationMinutes: Number(state.durationMinutes),
    bufferBeforeMinutes: Number(state.bufferBeforeMinutes),
    bufferAfterMinutes: Number(state.bufferAfterMinutes),
    requiresApproval: state.requiresApproval,
    minimumNoticeMinutes: numberValue(mode, state.minimumNoticeMinutes),
    maximumAdvanceDays: numberValue(mode, state.maximumAdvanceDays),
    // A price and its currency travel together or not at all: the service layer
    // re-checks the *merged* row and rejects an amount with no currency. Blank
    // means "on request", which is not the same as free — hence null rather
    // than 0, and the currency is left alone so it survives being cleared.
    ...(price === ""
      ? { priceMinor: mode === "create" ? undefined : null }
      : {
          priceMinor: toMinorUnits(Number(price), state.currency),
          currency: state.currency,
        }),
  };
}

export function ServiceFields({
  state,
  onChange,
  idPrefix,
}: {
  state: ServiceFormState;
  onChange: (patch: Partial<ServiceFormState>) => void;
  /** Keeps ids unique when a create and an edit panel are on screen together. */
  idPrefix: string;
}): React.ReactElement {
  const t = useTranslations("catalogue");

  return (
    <>
      <Field id={`${idPrefix}-name`} label={t("name")}>
        <Input
          id={`${idPrefix}-name`}
          value={state.name}
          onChange={(event) => {
            onChange({ name: event.target.value });
          }}
          required
          minLength={2}
          maxLength={160}
          
        />
      </Field>

      <Field id={`${idPrefix}-slug`} label={t("slug")}>
        <Input
          id={`${idPrefix}-slug`}
          value={state.slug}
          onChange={(event) => {
            onChange({ slug: event.target.value });
          }}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          
        />
      </Field>
      <p className="text-xs text-ink-subtle">{t("slugHint")}</p>

      <Field id={`${idPrefix}-description`} label={t("description")}>
        <Textarea
          id={`${idPrefix}-description`}
          value={state.description}
          onChange={(event) => {
            onChange({ description: event.target.value });
          }}
          rows={3}
          maxLength={4000}
          
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        <Field id={`${idPrefix}-duration`} label={t("durationMinutes")}>
          <Input
            id={`${idPrefix}-duration`}
            type="number"
            min={5}
            max={1440}
            step={5}
            value={state.durationMinutes}
            onChange={(event) => {
              onChange({ durationMinutes: event.target.value });
            }}
            required
            className="w-32"
          />
        </Field>

        <Field id={`${idPrefix}-buffer-before`} label={t("bufferBefore")}>
          <Input
            id={`${idPrefix}-buffer-before`}
            type="number"
            min={0}
            max={240}
            step={5}
            value={state.bufferBeforeMinutes}
            onChange={(event) => {
              onChange({ bufferBeforeMinutes: event.target.value });
            }}
            className="w-32"
          />
        </Field>

        <Field id={`${idPrefix}-buffer-after`} label={t("bufferAfter")}>
          <Input
            id={`${idPrefix}-buffer-after`}
            type="number"
            min={0}
            max={240}
            step={5}
            value={state.bufferAfterMinutes}
            onChange={(event) => {
              onChange({ bufferAfterMinutes: event.target.value });
            }}
            className="w-32"
          />
        </Field>
      </div>
      <p className="text-xs text-ink-subtle">{t("bufferHint")}</p>

      <div className="flex flex-wrap gap-3">
        <Field id={`${idPrefix}-price`} label={t("priceOptional")}>
          <Input
            id={`${idPrefix}-price`}
            type="number"
            min={0}
            step="0.01"
            value={state.price}
            onChange={(event) => {
              onChange({ price: event.target.value });
            }}
            className="w-40"
          />
        </Field>

        <Field id={`${idPrefix}-currency`} label={t("currency")}>
          <Select
            id={`${idPrefix}-currency`}
            value={state.currency}
            onChange={(event) => {
              onChange({ currency: event.target.value });
            }}
            
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap gap-3">
        <Field id={`${idPrefix}-notice`} label={t("minimumNotice")}>
          <Input
            id={`${idPrefix}-notice`}
            type="number"
            min={0}
            max={43200}
            value={state.minimumNoticeMinutes}
            onChange={(event) => {
              onChange({ minimumNoticeMinutes: event.target.value });
            }}
            className="w-40"
          />
        </Field>

        <Field id={`${idPrefix}-advance`} label={t("maximumAdvance")}>
          <Input
            id={`${idPrefix}-advance`}
            type="number"
            min={1}
            max={730}
            value={state.maximumAdvanceDays}
            onChange={(event) => {
              onChange({ maximumAdvanceDays: event.target.value });
            }}
            className="w-40"
          />
        </Field>
      </div>
      {/* Blank is not zero here: blank inherits, zero means "up to the last
          second". The hint says so because the input cannot. */}
      <p className="text-xs text-ink-subtle">{t("inheritHint")}</p>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={state.requiresApproval}
          onChange={(event) => {
            onChange({ requiresApproval: event.target.checked });
          }}
        />
        <span>{t("requiresApproval")}</span>
      </label>
      <p className="text-xs text-ink-subtle">{t("requiresApprovalHint")}</p>
    </>
  );
}
