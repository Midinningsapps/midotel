// Page sections: the building blocks of every hotel website page.
// Shared by the API (validation), the admin (editor forms) and the site renderer (themes).
import { z } from 'zod';

const id = z.string().min(1).max(40);
const text = (max: number) => z.string().max(max).default('');
const images = z.array(z.uuid()).max(30).default([]);

export const HeroSection = z.object({
  id,
  type: z.literal('hero'),
  data: z.object({
    heading: text(120),
    subheading: text(240),
    imageIds: images,
    showBookingBar: z.boolean().default(true),
  }),
});

export const TextSection = z.object({
  id,
  type: z.literal('text'),
  data: z.object({
    eyebrow: text(60),
    heading: text(120),
    body: text(5000),
    imageId: z.uuid().nullable().default(null),
    imageSide: z.enum(['left', 'right']).default('right'),
  }),
});

export const RoomsSection = z.object({
  id,
  type: z.literal('rooms'),
  data: z.object({ heading: text(120), intro: text(600) }),
});

export const AmenitiesSection = z.object({
  id,
  type: z.literal('amenities'),
  data: z.object({ heading: text(120), intro: text(600) }),
});

export const GallerySection = z.object({
  id,
  type: z.literal('gallery'),
  data: z.object({ heading: text(120), imageIds: images }),
});

export const CtaSection = z.object({
  id,
  type: z.literal('cta'),
  data: z.object({
    heading: text(120),
    body: text(600),
    buttonLabel: text(40),
    buttonLink: z.string().max(500).default('#book'),
  }),
});

export const ContactSection = z.object({
  id,
  type: z.literal('contact'),
  data: z.object({ heading: text(120), intro: text(600), showMap: z.boolean().default(true) }),
});

export const Section = z.discriminatedUnion('type', [
  HeroSection,
  TextSection,
  RoomsSection,
  AmenitiesSection,
  GallerySection,
  CtaSection,
  ContactSection,
]);
export type Section = z.infer<typeof Section>;
export type SectionType = Section['type'];

export const Sections = z.array(Section).max(40);

export const SECTION_LABELS: Record<SectionType, string> = {
  hero: 'Hero with photos',
  text: 'Text and image',
  rooms: 'Rooms list',
  amenities: 'Amenities',
  gallery: 'Photo gallery',
  cta: 'Call to action',
  contact: 'Contact and map',
};

/** A new section of this type with sensible empty content. */
export function newSection(type: SectionType, sectionId: string): Section {
  return Section.parse({ id: sectionId, type, data: {} });
}

/** Image ids referenced by a list of sections (to resolve URLs in one query). */
export function imageIdsIn(sections: Section[]): string[] {
  const ids = new Set<string>();
  for (const s of sections) {
    if (s.type === 'hero' || s.type === 'gallery') s.data.imageIds.forEach((i) => ids.add(i));
    if (s.type === 'text' && s.data.imageId) ids.add(s.data.imageId);
  }
  return [...ids];
}

/** Theme tokens a hotel can change without code. */
export const ThemeTokens = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#1f4e5f'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c8873a'),
  headingFont: z.enum(['serif', 'sans']).default('serif'),
});
export type ThemeTokens = z.infer<typeof ThemeTokens>;

export const THEMES = [{ id: 'aurora', name: 'Aurora', description: 'Calm, photo-led layout for heritage and leisure hotels' }] as const;

/** Starter pages for a new hotel site, written to be edited. */
export function starterPages(propertyName: string, newId: () => string) {
  return [
    {
      slug: 'home',
      title: 'Home',
      kind: 'home' as const,
      sortOrder: 0,
      sections: [
        { id: newId(), type: 'hero', data: { heading: `Welcome to ${propertyName}`, subheading: 'Book direct for the best rates' } },
        {
          id: newId(),
          type: 'text',
          data: { eyebrow: 'About us', heading: 'A stay to remember', body: 'Tell guests what makes your hotel special.' },
        },
        { id: newId(), type: 'rooms', data: { heading: 'Rooms and suites', intro: '' } },
        { id: newId(), type: 'amenities', data: { heading: 'Amenities', intro: '' } },
        { id: newId(), type: 'contact', data: { heading: 'Find us', intro: '' } },
      ],
    },
    {
      slug: 'rooms',
      title: 'Rooms',
      kind: 'custom' as const,
      sortOrder: 10,
      sections: [{ id: newId(), type: 'rooms', data: { heading: 'Rooms and suites', intro: '' } }],
    },
    {
      slug: 'gallery',
      title: 'Gallery',
      kind: 'custom' as const,
      sortOrder: 20,
      sections: [{ id: newId(), type: 'gallery', data: { heading: 'Gallery' } }],
    },
    {
      slug: 'contact',
      title: 'Contact',
      kind: 'custom' as const,
      sortOrder: 30,
      sections: [{ id: newId(), type: 'contact', data: { heading: 'Contact us', intro: '' } }],
    },
  ].map((p) => ({ ...p, sections: Sections.parse(p.sections) }));
}
