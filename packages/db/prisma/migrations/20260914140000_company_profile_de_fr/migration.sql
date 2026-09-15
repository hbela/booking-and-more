ALTER TABLE "tenant_assistant_settings"
ADD COLUMN "business_description_de" TEXT,
ADD COLUMN "business_description_fr" TEXT;

UPDATE "tenant_assistant_settings" AS settings
SET "business_description_de" = CASE WHEN tenant."default_language" = 'de' THEN settings."business_description" END,
    "business_description_fr" = CASE WHEN tenant."default_language" = 'fr' THEN settings."business_description" END
FROM "tenants" AS tenant
WHERE tenant.id = settings.tenant_id;
