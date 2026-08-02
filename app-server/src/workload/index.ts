export {
	DEFAULT_WORKLOAD_SOCKET,
	WorkloadIdentityClient,
	WorkloadIdentityError,
	WorkloadPermissionDeniedError,
	getWorkloadIdentityClient,
} from './workload-identity.js';
export type {
	EffectiveCapabilities,
	WorkloadBinding,
	WorkloadBrokerContext,
	WorkloadBrokerResponse,
	WorkloadFetchInit,
	WorkloadIdentityClientOptions,
	WorkloadIdentityErrorCode,
} from './workload-identity.js';
export { verifyDispatchAssertion } from './dispatch-assertion.js';
export type { VerifiedDispatchActor, VerifiedDispatchAssertion } from './dispatch-assertion.js';
