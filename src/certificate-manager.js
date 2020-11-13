/**
 * Certificate Manager.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const acme = require('acme-client');
const config = require('config');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const Settings = require('./models/settings');
const sleep = require('./sleep');
const {URLSearchParams} = require('url');
const UserProfile = require('./user-profile');

const DEBUG = false || (process.env.NODE_ENV === 'test');

const DIRECTORY_URL = acme.directory.letsencrypt.production;

// For test purposes, uncomment the following:
// const DIRECTORY_URL = acme.directory.letsencrypt.staging;
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Write certificates generated by registration/renewal to disk.
 *
 * @param {string} certificate - The generated certificate
 * @param {string} privateKey - The generated private key
 * @param {string} chain - The generated certificate chain
 */
function writeCertificates(certificate, privateKey, chain) {
  fs.writeFileSync(
    path.join(UserProfile.sslDir, 'certificate.pem'),
    certificate
  );
  fs.writeFileSync(
    path.join(UserProfile.sslDir, 'privatekey.pem'),
    privateKey
  );
  fs.writeFileSync(
    path.join(UserProfile.sslDir, 'chain.pem'),
    chain
  );
}

/**
 * Register domain with Let's Encrypt and get certificates.
 *
 * @param {string} email - User's email address
 * @param {string?} reclamationToken - Reclamation token, if applicable
 * @param {string} subdomain - The subdomain being registered
 * @param {string} fulldomain - The full domain being registered
 * @param {boolean} optout - Whether or not the user opted out of emails
 * @param {function} callback - Callback function
 */
async function register(email, reclamationToken, subdomain, fulldomain,
                        optout, callback) {
  if (DEBUG) {
    console.debug('Starting registration:', email, reclamationToken, subdomain,
                  fulldomain, optout);
  } else {
    console.log('Starting registration');
  }

  const endpoint = config.get('ssltunnel.registration_endpoint');
  let token;

  // First, try to register the subdomain with the registration server.
  try {
    const params = new URLSearchParams();
    params.set('name', subdomain);
    params.set('email', email);

    if (reclamationToken) {
      params.set('reclamationToken', reclamationToken.trim());
    }

    const subscribeUrl = `${endpoint}/subscribe?${params.toString()}`;
    const res = await fetch(subscribeUrl);
    const jsonToken = await res.json();

    if (DEBUG) {
      console.debug('Sent subscription to registration server:', jsonToken);
    } else {
      console.log('Sent subscription to registration server');
    }

    if (jsonToken.error) {
      console.log('Error received from registration server:', jsonToken.error);
      callback(jsonToken.error);
      return;
    }

    token = jsonToken.token;

    // Store the token in the db
    await Settings.set('tunneltoken', jsonToken);
  } catch (e) {
    console.error('Failed to subscribe:', e);
    callback(e);
    return;
  }

  // Now we associate user's email with the subdomain, unless it was reclaimed
  if (!reclamationToken) {
    const params = new URLSearchParams();
    params.set('token', token);
    params.set('email', email);
    params.set('optout', optout);

    try {
      await fetch(`${endpoint}/setemail?${params.toString()}`);
      console.log('Set email on server.');
    } catch (e) {
      console.error('Failed to set email on server:', e);

      // https://github.com/WebThingsIO/gateway/issues/358
      // we should store this error and display to the user on
      // settings page to allow him to retry
      callback(e);
      return;
    }
  }

  /**
   * Function used to satisfy an ACME challenge
   *
   * @param {object} authz Authorization object
   * @param {object} challenge Selected challenge
   * @param {string} keyAuthorization Authorization key
   * @returns {Promise}
   */
  const challengeCreateFn = async (_authz, _challenge, keyAuthorization) => {
    const params = new URLSearchParams();
    params.set('token', token);
    params.set('challenge', keyAuthorization);

    // Now that we have a challenge, we call our registration server to
    // setup the TXT record
    const response = await fetch(`${endpoint}/dnsconfig?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to set DNS token on server: ${response.status}`);
    }

    console.log('Set DNS token on registration server');

    // Let's wait a few seconds for changes to propagate on the registration
    // server and its database.
    await sleep(2500);
  };

  /**
   * Function used to remove an ACME challenge response
   *
   * @param {object} authz Authorization object
   * @param {object} challenge Selected challenge
   * @param {string} keyAuthorization Authorization key
   * @returns {Promise}
   */
  const challengeRemoveFn = async (_authz, _challenge, _keyAuthorization) => {
    // do nothing for now
  };

  try {
    // create an ACME client
    const client = new acme.Client({
      directoryUrl: DIRECTORY_URL,
      accountKey: await acme.forge.createPrivateKey(),
    });

    // create a CSR
    const [key, csr] = await acme.forge.createCsr({
      commonName: fulldomain,
    });

    // run the ACME registration
    const cert = await client.auto({
      csr,
      email: config.get('ssltunnel.certemail'),
      termsOfServiceAgreed: true,
      skipChallengeVerification: true,
      challengePriority: ['dns-01'],
      challengeCreateFn,
      challengeRemoveFn,
    });

    if (DEBUG) {
      console.debug('Private Key:', key.toString());
      console.debug('CSR:', csr.toString());
      console.debug('Certificate(s):', cert.toString());
    } else {
      console.log('Received certificate from Let\'s Encrypt');
    }

    const chain = cert
      .toString()
      .trim()
      .split(/[\r\n]{2,}/g)
      .map((s) => `${s}\n`);

    writeCertificates(chain[0], key.toString(), chain.join('\n'));
    console.log('Wrote certificates to file system');
  } catch (e) {
    console.error('Failed to generate certificate:', e);
    callback(e);
    return;
  }

  try {
    await fetch(
      `${endpoint}/newsletter/subscribe`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          subscribe: !optout,
        }),
      }
    );
  } catch (e) {
    console.error('Failed to subscribe to newsletter:', e);
  }

  console.log('Registration success!');
  callback();
}

/**
 * Try to renew the certificates associated with this domain.
 *
 * @param {Object} server - HTTPS server handle
 */
async function renew(server) {
  console.log('Starting certificate renewal.');

  // Check if we need to renew yet
  try {
    const oldCert = fs.readFileSync(
      path.join(UserProfile.sslDir, 'certificate.pem')
    );
    const info = await acme.forge.readCertificateInfo(oldCert);
    const now = new Date();

    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    if (info.notAfter - now >= oneWeek) {
      console.log('Certificate not yet due for renewal.');
      return;
    }
  } catch (_e) {
    // pass. move on to renewal.
  }

  let tunnelToken;
  try {
    tunnelToken = await Settings.get('tunneltoken');
  } catch (e) {
    console.error('Tunnel token not set!');
    return;
  }

  /**
   * Function used to satisfy an ACME challenge
   *
   * @param {object} authz Authorization object
   * @param {object} challenge Selected challenge
   * @param {string} keyAuthorization Authorization key
   * @returns {Promise}
   */
  const challengeCreateFn = async (_authz, challenge, keyAuthorization) => {
    const params = new URLSearchParams();
    params.set('token', tunnelToken.token);
    params.set('challenge', keyAuthorization);

    // Now that we have a challenge, we call our registration server to
    // setup the TXT record
    const endpoint = config.get('ssltunnel.registration_endpoint');
    const response = await fetch(`${endpoint}/dnsconfig?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to set DNS token on server: ${response.status}`);
    }

    console.log('Set DNS token on registration server');

    // Let's wait a few seconds for changes to propagate on the registration
    // server and its database.
    await sleep(2500);
  };

  /**
   * Function used to remove an ACME challenge response
   *
   * @param {object} authz Authorization object
   * @param {object} challenge Selected challenge
   * @param {string} keyAuthorization Authorization key
   * @returns {Promise}
   */
  const challengeRemoveFn = async (_authz, _challenge, _keyAuthorization) => {
    // do nothing for now
  };

  const domain = `${tunnelToken.name}.${config.get('ssltunnel.domain')}`;

  try {
    // create an ACME client
    const client = new acme.Client({
      directoryUrl: DIRECTORY_URL,
      accountKey: await acme.forge.createPrivateKey(),
    });

    // create a CSR
    const [key, csr] = await acme.forge.createCsr({
      commonName: domain,
    });

    // run the ACME registration
    const cert = await client.auto({
      csr,
      email: config.get('ssltunnel.certemail'),
      termsOfServiceAgreed: true,
      skipChallengeVerification: true,
      challengePriority: ['dns-01'],
      challengeCreateFn,
      challengeRemoveFn,
    });

    if (DEBUG) {
      console.debug('Private Key:', key.toString());
      console.debug('CSR:', csr.toString());
      console.debug('Certificate(s):', cert.toString());
    } else {
      console.log('Received certificate from Let\'s Encrypt');
    }

    const chain = cert
      .toString()
      .trim()
      .split(/[\r\n]{2,}/g)
      .map((s) => `${s}\n`);

    writeCertificates(chain[0], key.toString(), chain.join('\n'));
    console.log('Wrote certificates to file system');

    if (server) {
      const ctx = server._sharedCreds.context;
      ctx.setCert(chain[0]);
      ctx.setKey(key.toString());
      ctx.addCACert(chain.join('\n'));
    }
  } catch (e) {
    console.error('Failed to renew certificate:', e);
    return;
  }

  console.log('Renewal success!');
}

module.exports = {
  register,
  renew,
};
