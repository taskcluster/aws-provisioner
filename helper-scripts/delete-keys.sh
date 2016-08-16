#!/bin/bash
export NODE_ENV=${NODE_ENV:-production}

error () {
  echo ERROR: "$@"
  exit 1
}

keyname=$(cd .. && node -e "console.log(require('taskcluster-base').config().app.id)")-ssh-key

for region in $(cd .. && node -e "console.log(require('taskcluster-base').config().app.allowedRegions.join('\n'))") ; do
  echo Deleting key $keyname in $region
  aws --region $region ec2 delete-key-pair --key-name $keyname
  if [ $? -eq 0 ] ; then
    echo Success
  else
    error deleting key $keyname in $region
  fi
done
