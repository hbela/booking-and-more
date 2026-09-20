// Test-process-only module loader. No real Stripe connection or mutation.
import { registerHooks } from "node:module";

const source = `
  export default class Stripe {
    customers = { retrieve: async (id) => ({ id, livemode: !id.startsWith('cus_test_') }) };
    subscriptions = { retrieve: async (id) => ({ id, livemode: !id.startsWith('sub_test_') }) };
    paymentLinks = { retrieve: async (id) => ({ id, livemode: !id.startsWith('plink_test_') }) };
    invoices = { retrieve: async (id) => ({ id, livemode: !id.startsWith('in_test_') }) };
  }
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "stripe")
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
