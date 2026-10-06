// Synthetic identifiers only. Never use a live tenant/client ID in test fixtures.
export const clientIdFor = organization => Buffer.from(`${organization}.11111111-1111-4111-8111-111111111111`, 'utf8').toString('base64');
