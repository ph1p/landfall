// The cloud providers landfall knows. No node: imports here: the web page reads this list too.

export interface Cloud {
  id: string;
  name: string;
  /** The provider's firewall, where every server sits behind one that is closed until a port is opened. */
  firewall?: string;
}
/**
 * Providers the probe recognises (templates.ts CLOUD). With `firewall`, ufw would only repeat the provider's
 * rules, so setup leaves it out. The others offer a firewall too, but a server has none until someone adds it.
 */
export const CLOUDS: Record<string, Omit<Cloud, "id">> = {
  aws: { name: "AWS", firewall: "security group" },
  gcp: { name: "Google Cloud", firewall: "VPC firewall" },
  azure: { name: "Azure", firewall: "network security group" },
  oracle: { name: "Oracle Cloud", firewall: "security list" },
  alibaba: { name: "Alibaba Cloud", firewall: "security group" },
  hetzner: { name: "Hetzner" },
  digitalocean: { name: "DigitalOcean" },
  vultr: { name: "Vultr" },
  linode: { name: "Akamai (Linode)" },
  scaleway: { name: "Scaleway" },
  upcloud: { name: "UpCloud" },
};
