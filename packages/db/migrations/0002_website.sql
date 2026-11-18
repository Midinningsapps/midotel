-- Phase 1: website builder. One site per property, pages made of JSON sections, uploaded media.

CREATE TABLE site (
  property_id        uuid PRIMARY KEY REFERENCES property(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  theme              text NOT NULL DEFAULT 'aurora',
  tokens             jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_version  integer NOT NULL DEFAULT 0,
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE site ENABLE ROW LEVEL SECURITY;
ALTER TABLE site FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER site_touch BEFORE UPDATE ON site FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE page (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  slug             text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title            text NOT NULL,
  kind             text NOT NULL DEFAULT 'custom' CHECK (kind IN ('home', 'custom')),
  sort_order       integer NOT NULL DEFAULT 0,
  show_in_menu     boolean NOT NULL DEFAULT true,
  seo_title        text CHECK (char_length(seo_title) <= 70),
  seo_description  text CHECK (char_length(seo_description) <= 170),
  draft            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- array of sections being edited
  published        jsonb,                                -- array of sections live on the site
  published_meta   jsonb,                                -- title, seo, menu settings at publish time
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, slug)
);
CREATE UNIQUE INDEX page_one_home_idx ON page (property_id) WHERE kind = 'home';
CREATE INDEX page_property_idx ON page (property_id, sort_order);
ALTER TABLE page ENABLE ROW LEVEL SECURITY;
ALTER TABLE page FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON page
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER page_touch BEFORE UPDATE ON page FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE media_asset (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id   uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif')),
  byte_size     integer NOT NULL CHECK (byte_size > 0),
  storage_key   text NOT NULL UNIQUE,
  alt           text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_asset_property_idx ON media_asset (property_id, created_at DESC);
ALTER TABLE media_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_asset FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_asset
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Room photos: ordered list of media ids.
ALTER TABLE room_type ADD COLUMN image_ids uuid[] NOT NULL DEFAULT '{}';

-- Amenities shown on the website.
ALTER TABLE property ADD COLUMN amenities text[] NOT NULL DEFAULT '{}';

GRANT SELECT, INSERT, UPDATE, DELETE ON site, page, media_asset TO midotel_app;
