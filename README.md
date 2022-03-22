# Google Cloud Storage backed SFTP server.

This is a fork of [kolban-google/sftp-gcs](https://github.com/kolban-google/sftp-gcs). See his full ReadMe below, note that the arguments are disabled in this fork.

## Disclaimer

This repo has _NO_ affiliation with Google more than using its services. It also is only tested for one small use case for our specific needs so use with caution and test extensively before relying on this code.

## Usage

-  First create `.env` in the root file, see description of the variables below.
-  Add user data. See `users.example.json` for examles.
-  Install node 12:
```
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_12.x | sudo -E bash -
sudo apt-get install -y nodejs
```
-  `npm install`
-  `npm run build && npm start` OR `npm run dev`

Or for running in Docker you can run the following (after you created env variables & user data if needed):

```sh
docker build -t sftp . && \
docker run --rm -it \
	--mount type=bind,source=/path/to/credentials.json,target=/usr/src/app/key.json \
	-p 9022:9022/tcp \
	sftp:latest
```

**Running with PM2 for production:**

Follow this tutorial: https://www.digitalocean.com/community/tutorials/how-to-set-up-a-node-js-application-for-production-on-ubuntu-20-04

Short version of it:
```sh
sudo npm install pm2@latest -g
npm run build

# Start SFTP Server
pm2 start npm -- start

# Restarts sftp server when server reboots
pm2 startup systemd
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u noahgary --hp /home/noahgary
```

### Environment variables

| Name           | Description                                        | Required | Default value                              |
| -------------- | -------------------------------------------------- | -------- | ------------------------------------------ |
| KEY_FILE       | Path to the service account credential file        | No       | process.env.GOOGLE_APPLICATION_CREDENTIALS |
| PORT           | Port where the server should be exposed            | No       | 22                                         |
| DEBUG_LEVEL    | Which logs should be generated                     | No       | 'info'                                     |
| USER_FILE      | Path to the file where the user data is located    | No       | ''                                         |
| PUB_KEY_FILE   | Path to the file where the public keys are located | No       | ''                                         |
| IP_PATTERN     | Pattern of what IP adresses to allow to connect    | No       | '0.0.0.0'                                  |
| DEFAULT_BUCKET | Bucket to use when authType is "none"              | No       | 'default'                                  |

## Original Readme

SFTP is the ability to transfer files using a protocol built on top of SSH. Currently, GCP does not have any pre-supplied products to be able to use SFTP to move files to or from Google Cloud Storage (GCS). There are a number of 3rd party products that are available from GCP marketplace that do offer this ability.

The SFTP protocol is an open standard. A variety of programming libraries have been developed which implement the protocol. What this means is that we can use these libraries to implement our own SFTP server application. We have done just that and used Google Cloud Storage as the back-end storage media for the files. When an SFTP client connects to our server and it puts or gets files, these are written and read from GCS data.

The application is written in Node.js and has been tested in a variety of runtimes including running as a container.

The current implementation of the solution supports only a single target bucket.

In order for the SFTP application to be able to read and write from GCS, it must have an identity that it can use to authenticate. The current implementation uses application default credentials. This means that the application uses the environment configured values.

Arguments:

-  `--bucket [BUCKET_NAME]` - The name of the bucket to work against. This is a **required** parameter.
-  `--port [PORT_NUMBER]` - The TCP/IP port number for the server to listen upon. Defaults to 22.
-  `--user [USER_NAME]` - User name for SFTP client access.
-  `--password [PASSWORD]` - Password for SFTP client access.
-  `--public-key-file [PUBLIC_KEY_FILE]` - File for SSH security for public key connection.
-  `--service-account-key-file [KEY_FILE]` - A path to a local file that contains the keys for a Service Account.
-  `--debug [DEBUG-LEVEL]` - The logging level at which messages are logged. The default is `info`. Set to `debug` for lowest level logging.

The application needs credentials to be able to interact with GCS. The default is to use the application default credentials for the environment in which the application is running. These will either be retrieved from the server's metadata (if the application is running on GCP) or from the `GOOGLE_APPLICATION_CREDENTIALS` environment variable if set. We can use the `--service-account-key-file` to explicitly point to a file local to the application from which service account keys may be retrieved. If supplied, this will be used in preference to other stories.

When the sftp-gcs server is running we can connect SFTP clients to the server. In order to connect we must provide credentials. We have choices.

1. The client can posses a private key for the corresponding public key supplied in `--public-key-file`.
2. The client can supply a userid/password pair.
3. The client need not supply any credentials for access.

See also:

-  [sftp command - man(1) - sftp](https://linux.die.net/man/1/sftp)
-  [SSH File Transfer Protocol](https://en.wikipedia.org/wiki/SSH_File_Transfer_Protocols)
-  [SSH File Transfer Protocol - draft-ietf-secsh-filexfer-02.txt](https://tools.ietf.org/html/draft-ietf-secsh-filexfer-02)
