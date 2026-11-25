// The cloud providers landfall knows. No node: imports here: the web page reads this list too.

export interface Cloud {
  id: string;
  name: string;
  /** The provider's firewall, where every server sits behind one that is closed until a port is opened. */
  firewall?: string;
  /** Where the provider's servers and firewalls are managed. */
  console?: string;
}
/**
 * Providers the probe recognises (templates.ts CLOUD). With `firewall`, ufw would only repeat the provider's
 * rules, so setup leaves it out. The others offer a firewall too, but a server has none until someone adds it.
 */
export const CLOUDS: Record<string, Omit<Cloud, "id">> = {
  aws: { name: "AWS", firewall: "security group", console: "https://console.aws.amazon.com/ec2/" },
  gcp: { name: "Google Cloud", firewall: "VPC firewall", console: "https://console.cloud.google.com/compute/instances" },
  azure: { name: "Azure", firewall: "network security group", console: "https://portal.azure.com/" },
  oracle: { name: "Oracle Cloud", firewall: "security list", console: "https://cloud.oracle.com/" },
  alibaba: { name: "Alibaba Cloud", firewall: "security group", console: "https://ecs.console.aliyun.com/" },
  hetzner: { name: "Hetzner", console: "https://console.hetzner.cloud/" },
  digitalocean: { name: "DigitalOcean", console: "https://cloud.digitalocean.com/droplets" },
  vultr: { name: "Vultr", console: "https://my.vultr.com/" },
  linode: { name: "Akamai (Linode)", console: "https://cloud.linode.com/linodes" },
  scaleway: { name: "Scaleway", console: "https://console.scaleway.com/" },
  upcloud: { name: "UpCloud", console: "https://hub.upcloud.com/" },
};
