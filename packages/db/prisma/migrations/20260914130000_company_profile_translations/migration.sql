ALTER TABLE "tenant_assistant_settings"
ADD COLUMN "business_description_hu" TEXT,
ADD COLUMN "business_description_en" TEXT;

-- Preserve existing profiles under the company's original language.
UPDATE "tenant_assistant_settings" AS settings
SET "business_description_hu" = CASE WHEN tenant."default_language" = 'hu' THEN settings."business_description" END,
    "business_description_en" = CASE WHEN tenant."default_language" = 'en' THEN settings."business_description" END
FROM "tenants" AS tenant
WHERE tenant.id = settings.tenant_id;
