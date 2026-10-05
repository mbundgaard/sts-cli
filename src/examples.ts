import { CliError, Exit } from './output.js';
export const examples: Record<string, Record<string, unknown>> = {
  'service-total': { menuItems: [{ menuItemId: 0, quantity: 1 }], tenders: [{ tenderId: 0, total: 0 }] },
  payment: { menuItems: [{ menuItemId: 0, quantity: 1 }], tenders: [{ tenderId: 0, total: 0 }] },
  'tender-only': { tenders: [{ tenderId: 0, total: 0 }] },
  calculate: { menuItems: [{ menuItemId: 0, quantity: 1 }] },
  tip: { menuItems: [{ menuItemId: 0, quantity: 1 }], tenders: [{ tenderId: 0, total: 120, chargedTipTotal: 20 }] },
  condiment: { menuItems: [{ menuItemId: 0, quantity: 1, condiments: [{ condimentId: 0, quantity: 1 }] }], tenders: [{ tenderId: 0, total: 0 }] },
};
export function example(name: string) {
  if (!Object.hasOwn(examples, name)) throw new CliError(Exit.usage, `Unknown example: ${name}. Choose ${Object.keys(examples).join(', ')}`);
  return examples[name];
}
