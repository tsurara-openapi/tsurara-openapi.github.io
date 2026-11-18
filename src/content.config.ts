import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // The file of the tsurara repository this page comes from.
        sourcePath: z.string().optional(),
        // A hash of the English text; a translation records the hash of the text it was made from.
        sourceHash: z.string().optional(),
      }),
    }),
  }),
};
