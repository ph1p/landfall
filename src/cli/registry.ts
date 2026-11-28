import { aliases } from "../core/lib/aliases";
import type { Command } from "./cmd";
import { auth, domains, open } from "./commands/access";
import { config } from "./commands/config";
import { deploy } from "./commands/deploy";
import { autodeploy } from "./commands/autodeploy";
import { ciInit, ciRm } from "./commands/ci";
import { gitKey, gitTrack } from "./commands/git";
import { promote, refs } from "./commands/refs";
import { eject, init } from "./commands/init";
import {
  serverAdd,
  serverConfig,
  serverDomain,
  serverInfo,
  serverList,
  serverRemove,
  serverSsh,
  serverUninstall,
  serverUpgrade,
  serverUse,
} from "./commands/server";
import { firewallAllow, firewallDeny, firewallDisable, firewallEnable, firewallRemove, firewallStatus, firewallUpdate } from "./commands/firewall";
import { historyLog, historyUndo } from "./commands/history";
import { keygen, setup } from "./commands/setup";
import {
  sitesEnv,
  sitesSecret,
  sitesInfo,
  sitesList,
  sitesLogs,
  sitesRemove,
  sitesAdopt,
  sitesRestart,
  releaseRemove,
  sitesRollback,
  sitesStart,
  sitesStop,
  sitesTunnel,
  tunnelsList,
} from "./commands/sites";
import { diskCmd, statsCmd } from "./commands/stats";
import { certsCmd, checkCmd, trafficCmd } from "./commands/traffic";
import { pruneCmd, rebootCmd } from "./commands/manage";
import {
  hostnameCmd,
  keysAdd,
  keysList,
  keysRemove,
  logLimitCmd,
  servicesList,
  servicesLogs,
  servicesRestart,
  servicesStart,
  servicesStop,
  swapCmd,
  systemCmd,
  timezoneCmd,
} from "./commands/system";
import { hardenCmd, securityCmd } from "./commands/security";
import { usersAdd, usersList, usersPasswd, usersRemove, usersSudo } from "./commands/users";
import {
  tenantAdd,
  tenantDomains,
  tenantInviteCmd,
  tenantLimits,
  tenantList,
  tenantOff,
  tenantRemove,
  tenantRestore,
  tenantRights,
  tenantStart,
  tenantStop,
} from "./commands/tenant";
import { ui } from "./commands/ui";
import { pluginAdd, pluginNew, pluginRemove, pluginsList } from "./commands/plugins";
import { volumeAdd, volumeBackup, volumeBackupRemove, volumeList, volumePull, volumePush, volumeRemove, volumeRestore } from "./commands/volume";
import { update, updatesList } from "./commands/updates";
import { scanCmd } from "./commands/scan";
import { scale, weight } from "./commands/scale";
import { registryList, registryLoginCmd, registryLogoutCmd } from "./commands/registries";
import { redirectAdd, redirectRemove, redirectsList } from "./commands/redirects";
import {
  traefikAccessLog,
  traefikDashboard,
  traefikLogs,
  traefikRemove,
  traefikRestart,
  traefikSetup,
  traefikStatus,
  traefikStrictTls,
  traefikUse,
} from "./commands/traefik";

/** Registration only: importing commands must never start the CLI. */
export const commands: Command[] = [
  setup,
  init,
  eject,
  deploy,
  refs,
  promote,
  gitTrack,
  gitKey,
  ciInit,
  ciRm,
  autodeploy,
  sitesList,
  sitesInfo,
  sitesLogs,
  sitesEnv,
  sitesSecret,
  scale,
  weight,
  sitesRollback,
  releaseRemove,
  sitesRestart,
  sitesStop,
  sitesStart,
  sitesRemove,
  sitesAdopt,
  sitesTunnel,
  tunnelsList,
  redirectsList,
  redirectAdd,
  redirectRemove,
  registryList,
  registryLoginCmd,
  registryLogoutCmd,
  volumeList,
  volumeBackup,
  volumePull,
  volumePush,
  volumeRestore,
  volumeBackupRemove,
  volumeAdd,
  volumeRemove,
  domains,
  auth,
  open,
  updatesList,
  scanCmd,
  update,
  serverAdd,
  serverList,
  serverInfo,
  serverUpgrade,
  statsCmd,
  diskCmd,
  trafficCmd,
  certsCmd,
  checkCmd,
  pruneCmd,
  rebootCmd,
  systemCmd,
  securityCmd,
  hardenCmd,
  servicesList,
  servicesRestart,
  servicesStart,
  servicesStop,
  servicesLogs,
  keysList,
  keysAdd,
  keysRemove,
  usersList,
  usersAdd,
  usersRemove,
  usersPasswd,
  usersSudo,
  tenantAdd,
  tenantList,
  tenantDomains,
  tenantLimits,
  tenantRights,
  tenantInviteCmd,
  tenantStop,
  tenantStart,
  tenantRemove,
  tenantRestore,
  tenantOff,
  swapCmd,
  hostnameCmd,
  timezoneCmd,
  logLimitCmd,
  serverConfig,
  serverDomain,
  serverUse,
  serverRemove,
  serverUninstall,
  serverSsh,
  traefikSetup,
  traefikUse,
  traefikStatus,
  traefikDashboard,
  traefikRestart,
  traefikAccessLog,
  traefikStrictTls,
  traefikLogs,
  traefikRemove,
  firewallStatus,
  firewallEnable,
  firewallDisable,
  firewallAllow,
  firewallDeny,
  firewallUpdate,
  firewallRemove,
  historyLog,
  historyUndo,
  keygen,
  config,
  ui,
  pluginsList,
  pluginAdd,
  pluginRemove,
  pluginNew,
];

/** Shorthands → canonical command names. */

export { aliases };

export const byName = new Map(commands.map((cmd) => [cmd.name, cmd]));

export function find(argv: string[]): { cmd?: Command; rest: string[]; prefix: number } {
  for (const n of [3, 2, 1]) {
    const key = argv.slice(0, n).join(" ");
    const cmd = byName.get(aliases[key] ?? key);
    if (cmd && argv.length >= n) return { cmd, rest: argv.slice(n), prefix: n };
  }
  return { rest: argv, prefix: 0 };
}
