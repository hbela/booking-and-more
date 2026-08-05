"use client";

import { useTranslations } from "next-intl";
import type { Provider } from "@/lib/api-client";
import {
  LOCALES,
  numberValue,
  supportedTimeZones,
  textValue,
  type FormMode,
} from "@/lib/catalogue-form";
import { Field, inputClass } from "./dashboard-shell";

/**
 * One field set, used by both the create panel and the edit panel.
 *
 * Nine of a provider's fields were unreachable from the dashboard because
 * create and edit were going to be different code, and edit never got written.
 * Sharing the component is what stops that recurring.
 */

export interface ProviderFormState {
  displayName: string;
  description: string;
  email: string;
  phone: string;
  timezone: string;
  languages: string[];
  onlineBookingEnabled: boolean;
  minimumNoticeMinutes: string;
  maximumAdvanceDays: string;
}

export function providerStateFrom(provider?: Provider): ProviderFormState {
  return {
    displayName: provider?.displayName ?? "",
    description: provider?.description ?? "",
    email: provider?.email ?? "",
    phone: provider?.phone ?? "",
    // Blank on create: the server falls back to the tenant's zone rather than
    // leaving it NULL, because "no zone" is not a question with a sensible
    // default answer during a DST transition (tech-impl §13.4).
    timezone: provider?.timezone ?? "",
    languages: provider?.languages ?? [],
    onlineBookingEnabled: provider?.onlineBookingEnabled ?? true,
    minimumNoticeMinutes:
      provider?.minimumNoticeMinutes == null ? "" : String(provider.minimumNoticeMinutes),
    maximumAdvanceDays:
      provider?.maximumAdvanceDays == null ? "" : String(provider.maximumAdvanceDays),
  };
}

export function providerBodyFrom(
  state: ProviderFormState,
  mode: FormMode,
): Record<string, unknown> {
  return {
    displayName: state.displayName.trim(),
    description: textValue(mode, state.description),
    // Required in both modes, and never null: the API refuses to clear it, so
    // `textValue`'s blank-means-null patch behaviour would produce a 422 rather
    // than an empty address.
    email: state.email.trim(),
    phone: textValue(mode, state.phone),
    // `timezone` is not nullable on either schema — a provider always has one —
    // so a blank box is omitted in both modes rather than sent as null.
    ...(state.timezone.trim() === "" ? {} : { timezone: state.timezone.trim() }),
    // Likewise languages: an empty array is a valid, meaningful value, so it is
    // sent as an array rather than collapsed into "unset".
    ...(mode === "create" && state.languages.length === 0 ? {} : { languages: state.languages }),
    onlineBookingEnabled: state.onlineBookingEnabled,
    minimumNoticeMinutes: numberValue(mode, state.minimumNoticeMinutes),
    maximumAdvanceDays: numberValue(mode, state.maximumAdvanceDays),
  };
}

export function ProviderFields({
  state,
  onChange,
  idPrefix,
}: {
  state: ProviderFormState;
  onChange: (patch: Partial<ProviderFormState>) => void;
  idPrefix: string;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const zones = supportedTimeZones();

  return (
    <>
      <Field id={`${idPrefix}-name`} label={t("name")}>
        <input
          id={`${idPrefix}-name`}
          value={state.displayName}
          onChange={(event) => {
            onChange({ displayName: event.target.value });
          }}
          required
          minLength={2}
          maxLength={160}
          className={inputClass}
        />
      </Field>

      <Field id={`${idPrefix}-description`} label={t("description")}>
        <textarea
          id={`${idPrefix}-description`}
          value={state.description}
          onChange={(event) => {
            onChange({ description: event.target.value });
          }}
          rows={3}
          maxLength={4000}
          className={inputClass}
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        {/* Required. A provider is a diary rather than a login, so this address
            signs nobody in — it is how the person behind the diary is reached at
            all, including by the invitation that would later give them one. */}
        <Field id={`${idPrefix}-email`} label={t("email")}>
          <input
            id={`${idPrefix}-email`}
            type="email"
            value={state.email}
            onChange={(event) => {
              onChange({ email: event.target.value });
            }}
            required
            className={inputClass}
          />
        </Field>

        <Field id={`${idPrefix}-phone`} label={t("phone")}>
          <input
            id={`${idPrefix}-phone`}
            type="tel"
            value={state.phone}
            onChange={(event) => {
              onChange({ phone: event.target.value });
            }}
            maxLength={40}
            className={inputClass}
          />
        </Field>
      </div>

      {/* A suggestion list, not a constraint: `list` leaves the input free text,
          so a browser that cannot enumerate zones degrades to typing one rather
          than to being unable to set one. The server validates either way. */}
      <Field id={`${idPrefix}-timezone`} label={t("timezone")}>
        <input
          id={`${idPrefix}-timezone`}
          value={state.timezone}
          onChange={(event) => {
            onChange({ timezone: event.target.value });
          }}
          list={zones.length === 0 ? undefined : `${idPrefix}-zones`}
          className={inputClass}
        />
      </Field>
      {zones.length === 0 ? null : (
        <datalist id={`${idPrefix}-zones`}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t("languages")}</legend>
        <div className="flex flex-wrap gap-3">
          {LOCALES.map((locale) => (
            <label key={locale} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.languages.includes(locale)}
                onChange={(event) => {
                  onChange({
                    // Rebuilt from LOCALES rather than pushed onto, so the order
                    // is stable and `diffPatch`'s content comparison is not
                    // defeated by two equal sets in different orders.
                    languages: event.target.checked
                      ? LOCALES.filter(
                          (code) => code === locale || state.languages.includes(code),
                        )
                      : state.languages.filter((code) => code !== locale),
                  });
                }}
              />
              <span>{t(`language.${locale}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <Field id={`${idPrefix}-notice`} label={t("minimumNotice")}>
          <input
            id={`${idPrefix}-notice`}
            type="number"
            min={0}
            max={43200}
            value={state.minimumNoticeMinutes}
            onChange={(event) => {
              onChange({ minimumNoticeMinutes: event.target.value });
            }}
            className={`${inputClass} w-40`}
          />
        </Field>

        <Field id={`${idPrefix}-advance`} label={t("maximumAdvance")}>
          <input
            id={`${idPrefix}-advance`}
            type="number"
            min={1}
            max={730}
            value={state.maximumAdvanceDays}
            onChange={(event) => {
              onChange({ maximumAdvanceDays: event.target.value });
            }}
            className={`${inputClass} w-40`}
          />
        </Field>
      </div>
      <p className="text-xs text-slate-500">{t("inheritHint")}</p>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={state.onlineBookingEnabled}
          onChange={(event) => {
            onChange({ onlineBookingEnabled: event.target.checked });
          }}
        />
        <span>{t("onlineBooking")}</span>
      </label>
      <p className="text-xs text-slate-500">{t("onlineBookingHint")}</p>
    </>
  );
}
