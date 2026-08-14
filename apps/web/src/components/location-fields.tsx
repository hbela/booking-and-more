"use client";

import { useTranslations } from "next-intl";
import type { Location, LocationType } from "@/lib/api-client";
import { numberValue, supportedTimeZones, textValue, type FormMode } from "@/lib/catalogue-form";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";

const TYPES: LocationType[] = ["PHYSICAL", "ONLINE", "HOME_VISIT", "TELEPHONE"];

/** Types that put the customer somewhere specific, and so need an address.
 *  Mirrors `ADDRESSED_TYPES` in `location.schemas.ts`. */
const ADDRESSED_TYPES: LocationType[] = ["PHYSICAL"];

export interface LocationFormState {
  name: string;
  type: LocationType;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  countryCode: string;
  timezone: string;
  latitude: string;
  longitude: string;
}

export function locationStateFrom(location?: Location): LocationFormState {
  return {
    name: location?.name ?? "",
    type: location?.type ?? "PHYSICAL",
    addressLine1: location?.addressLine1 ?? "",
    addressLine2: location?.addressLine2 ?? "",
    postalCode: location?.postalCode ?? "",
    city: location?.city ?? "",
    countryCode: location?.countryCode ?? "",
    timezone: location?.timezone ?? "",
    latitude: location?.latitude == null ? "" : String(location.latitude),
    longitude: location?.longitude == null ? "" : String(location.longitude),
  };
}

export function locationBodyFrom(
  state: LocationFormState,
  mode: FormMode,
): Record<string, unknown> {
  return {
    name: state.name.trim(),
    type: state.type,
    // Switching PHYSICAL → ONLINE deliberately leaves the address in place: the
    // same room may go back to in-person next month, and silently discarding
    // what the user typed is worse than carrying a field nothing reads
    // (location.schemas.ts §68-73). So the address travels regardless of type.
    addressLine1: textValue(mode, state.addressLine1),
    addressLine2: textValue(mode, state.addressLine2),
    postalCode: textValue(mode, state.postalCode),
    city: textValue(mode, state.city),
    countryCode: textValue(mode, state.countryCode.toUpperCase()),
    ...(state.timezone.trim() === "" ? {} : { timezone: state.timezone.trim() }),
    latitude: numberValue(mode, state.latitude),
    longitude: numberValue(mode, state.longitude),
  };
}

export function LocationFields({
  state,
  onChange,
  idPrefix,
}: {
  state: LocationFormState;
  onChange: (patch: Partial<LocationFormState>) => void;
  idPrefix: string;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const zones = supportedTimeZones();

  // The API enforces this too, against the *merged* row. The form mirrors it so
  // the requirement is visible before the request rather than after it.
  const needsAddress = ADDRESSED_TYPES.includes(state.type);

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

      <Field id={`${idPrefix}-type`} label={t("type")}>
        <Select
          id={`${idPrefix}-type`}
          value={state.type}
          onChange={(event) => {
            onChange({ type: event.target.value as LocationType });
          }}
          
        >
          {TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`locationType.${value}`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field id={`${idPrefix}-address`} label={t("address")}>
        <Input
          id={`${idPrefix}-address`}
          value={state.addressLine1}
          onChange={(event) => {
            onChange({ addressLine1: event.target.value });
          }}
          required={needsAddress}
          maxLength={200}
          
        />
      </Field>

      <Field id={`${idPrefix}-address-2`} label={t("addressLine2")}>
        <Input
          id={`${idPrefix}-address-2`}
          value={state.addressLine2}
          onChange={(event) => {
            onChange({ addressLine2: event.target.value });
          }}
          maxLength={200}
          
        />
      </Field>

      {/* Postcode before city: that is the order a Hungarian address is written
          and read ("1134 Budapest"). */}
      <div className="flex flex-wrap gap-3">
        <Field id={`${idPrefix}-postal-code`} label={t("postalCode")}>
          <Input
            id={`${idPrefix}-postal-code`}
            value={state.postalCode}
            onChange={(event) => {
              onChange({ postalCode: event.target.value });
            }}
            inputMode="numeric"
            maxLength={20}
            className="w-32"
          />
        </Field>

        <Field id={`${idPrefix}-city`} label={t("city")}>
          <Input
            id={`${idPrefix}-city`}
            value={state.city}
            onChange={(event) => {
              onChange({ city: event.target.value });
            }}
            maxLength={120}
            
          />
        </Field>

        {/* Free text rather than a 250-entry select: that would be 250 message
            keys in two languages for no gain. Upper-cased on submit, as the
            schema does. */}
        <Field id={`${idPrefix}-country`} label={t("countryCode")}>
          <Input
            id={`${idPrefix}-country`}
            value={state.countryCode}
            onChange={(event) => {
              onChange({ countryCode: event.target.value });
            }}
            maxLength={2}
            pattern="[A-Za-z]{2}"
            className="w-20"
          />
        </Field>
      </div>

      <Field id={`${idPrefix}-timezone`} label={t("timezone")}>
        <Input
          id={`${idPrefix}-timezone`}
          value={state.timezone}
          onChange={(event) => {
            onChange({ timezone: event.target.value });
          }}
          list={zones.length === 0 ? undefined : `${idPrefix}-zones`}
          
        />
      </Field>
      {zones.length === 0 ? null : (
        <datalist id={`${idPrefix}-zones`}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      )}
      <p className="text-xs text-ink-subtle">{t("timezoneHint")}</p>

      {/* Stored but unread until the public map (phase-2 §5.5). Behind a
          disclosure so it is reachable without being in anybody's way. */}
      <details>
        <summary className="cursor-pointer text-sm text-ink-muted">
          {t("coordinates")}
        </summary>

        <div className="mt-2 flex flex-wrap gap-3 border-l border-line pl-3">
          <Field id={`${idPrefix}-latitude`} label={t("latitude")}>
            <Input
              id={`${idPrefix}-latitude`}
              type="number"
              min={-90}
              max={90}
              step="any"
              value={state.latitude}
              onChange={(event) => {
                onChange({ latitude: event.target.value });
              }}
              className="w-40"
            />
          </Field>

          <Field id={`${idPrefix}-longitude`} label={t("longitude")}>
            <Input
              id={`${idPrefix}-longitude`}
              type="number"
              min={-180}
              max={180}
              step="any"
              value={state.longitude}
              onChange={(event) => {
                onChange({ longitude: event.target.value });
              }}
              className="w-40"
            />
          </Field>
        </div>
      </details>
    </>
  );
}
