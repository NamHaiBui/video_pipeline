export function create_slug(input: string): string {
  // Convert to lowercase
  let slug = input.toLowerCase();

  // Replace spaces and special characters with hyphens
  slug = slug.replace(/[\s_]+/g, '-'); // Replace spaces and underscores with hyphens
  slug = slug.replace(/[^a-z0-9-]/g, ''); // Remove non-alphanumeric characters except hyphens

  // Remove leading and trailing hyphens
  slug = slug.replace(/^-+|-+$/g, '');

  return slug;
}