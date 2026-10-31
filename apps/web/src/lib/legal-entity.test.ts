import { describe, expect, it } from "vitest";
import { parseLegalEntity } from "./legal-entity";

describe("parseLegalEntity", () => {
  it("reads every field, trimmed", () => {
    expect(
      parseLegalEntity({
        LEGAL_NAME: " Example Seller ",
        LEGAL_ADDRESS: "1000 Budapest, Example utca 1.",
        LEGAL_TAX_NUMBER: "12345678-1-23",
        LEGAL_EU_VAT_NUMBER: "HU12345678",
        LEGAL_REGISTRATION_NUMBER: "00000000",
        LEGAL_EMAIL: "hello@example.test",
      }),
    ).toEqual({
      name: "Example Seller",
      address: "1000 Budapest, Example utca 1.",
      taxNumber: "12345678-1-23",
      euVatNumber: "HU12345678",
      registrationNumber: "00000000",
      email: "hello@example.test",
    });
  });

  it("omits unset and blank fields rather than rendering empty lines", () => {
    expect(parseLegalEntity({ LEGAL_NAME: "Seller", LEGAL_ADDRESS: "  " })).toEqual({
      name: "Seller",
    });
  });

  it("drops an email that would make a broken mailto link", () => {
    expect(parseLegalEntity({ LEGAL_EMAIL: "not an address" })).toEqual({});
  });
});
