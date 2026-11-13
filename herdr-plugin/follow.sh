#!/bin/sh
# Follow pane: sf logs --container follows the picked agent from any folder.
sf logs --container "$SF_CONTAINER"
printf '\nsf logs ended. Press enter to close. '
read -r _
