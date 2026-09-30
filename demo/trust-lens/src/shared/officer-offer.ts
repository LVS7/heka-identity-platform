/**
 * The one place the Finance Data Officer offer is minted.
 *
 * Three callers need an identical offer: the seed (prints it for a phone), the simulated holder
 * (claims it in-process) and the TrustCo Console (pushes it to the wallet over DIDComm). Offers
 * carry a single-use pre-authorized code, so each caller mints its own — but the credential must
 * be the same in every case, status-bound to the officer's slot in the issuer's status list.
 */

import { ROLE_CREDENTIAL_VCT } from '../core/types'
import { SeedState } from '../seed/state'
import { OFFICER_CREDENTIAL, TRUSTCO } from './demo-config'
import { IssuanceOfferCredential, IssuanceOfferResponse } from './identity-service'

/** The slice of the Identity Service client this needs; narrow so it is testable offline. */
export interface OfficerOfferIssuer {
  statusListUrl(statusListId: string): string
  createIssuanceOffer(publicIssuerId: string, credentials: IssuanceOfferCredential[]): Promise<IssuanceOfferResponse>
}

export async function createOfficerOffer(issuer: OfficerOfferIssuer, state: SeedState): Promise<string> {
  const { issuerDid, statusListId } = state
  const statusListIndex = state.statusIndexes.officer
  if (!issuerDid || !statusListId || statusListIndex === undefined) {
    throw new Error('no seed state for the officer credential — run `yarn seed` first')
  }

  const { credentialOffer } = await issuer.createIssuanceOffer(issuerDid, [
    {
      format: 'vc+sd-jwt',
      credentialSupportedId: OFFICER_CREDENTIAL.configurationId,
      issuer: { method: 'did', did: issuerDid },
      payload: {
        vct: ROLE_CREDENTIAL_VCT,
        role: OFFICER_CREDENTIAL.role,
        org: TRUSTCO.legalName,
        credentialStatus: {
          statusListCredential: issuer.statusListUrl(statusListId),
          statusListIndex,
        },
      },
      // The operator discloses only role and org when authorizing a task.
      disclosureFrame: { _sd: [...OFFICER_CREDENTIAL.disclosed] },
    },
  ])

  return credentialOffer
}
