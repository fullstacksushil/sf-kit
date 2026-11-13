#!/bin/sh
# Follow pane: sf logs "<subject>" in the project folder, so sf resolves the right repo.
cd "$SF_DIR" || exit 1
sf logs "$SF_SUBJECT"
printf '\nsf logs ended. Press enter to close. '
read -r _
