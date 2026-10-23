import { setOfflineTransport } from '../providers/compat.js';
import { mockGateway } from './mock.js';

// The offline switch (HERMES_WEB_FRESH_OFFLINE=1, used by tests and the sandbox): every provider call of Fresh is answered by
// src/fresh/mock.js in the shapes of the real services, so the pipeline runs without a network and without a bill. The switch
// lives here, once, instead of in each caller: importing this module registers the fake transport, and the compat provider config
// uses it only while the flag is set (src/providers/compat.js checks at call time, so a test may turn the flag on and off).
export const offline = () => process.env.HERMES_WEB_FRESH_OFFLINE === '1';
setOfflineTransport(mockGateway);
