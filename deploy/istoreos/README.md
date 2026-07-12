# iStoreOS one-click deployment

This deployment uses Docker on an ARM64 N1 box. Syncinema listens on N1 port `3100`, leaving the iStoreOS administration ports unchanged.

## Install

Install Docker from the iStoreOS app store first, then run over SSH:

```sh
wget -qO /tmp/install-syncinema.sh \
  https://raw.githubusercontent.com/Ceylan233/syncinema/v1.6.0/deploy/istoreos/install.sh
sh /tmp/install-syncinema.sh
```

Open `http://N1-LAN-IP:3100/`. For temporary public access, forward an external TCP port to `N1-LAN-IP:3100`.

## Public-IP email notification

Edit `/mnt/data/syncinema/ip-monitor.env`. `MAIL_PASS` must be the SMTP authorization code, not the mailbox login password.

```sh
vi /mnt/data/syncinema/ip-monitor.env
sh /mnt/data/syncinema/source/deploy/istoreos/start-ip-monitor.sh
docker logs -f syncinema-ip-monitor
```

The notifier checks every five minutes and stores the previous address in `/mnt/data/syncinema/runtime/ip-monitor/public-ip.txt`.

## Manage

```sh
docker logs -f syncinema
docker restart syncinema
docker stop syncinema
```
