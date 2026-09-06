#!/bin/bash
# Assembles the single self-contained HTML file. This is a DEVELOPMENT step;
# the delivered artifact needs no build and no network.
set -e
cd "$(dirname "$0")"
CORE="00-util 05-logos 10-odds 20-devig 30-consensus 40-stake 50-arb 60-multiplicity 70-score 80-seed 85-slate 90-pipeline 91-adapters 92-live 93-refcmp 94-budget"
APP="95-app 96-views 96b-games 97-views2 97b-answer 98-views3 99-boot 99b-router"
OUT=edge-board.html

cat src/head.html > $OUT
echo '<script>' >> $OUT
echo "'use strict';" >> $OUT
echo 'var VB = {};' >> $OUT
echo '/*==VB-CORE-BEGIN==*/' >> $OUT
for f in $CORE; do echo "" >> $OUT; cat "src/$f.js" >> $OUT; done
echo '/*==VB-CORE-END==*/' >> $OUT
for f in $APP; do echo "" >> $OUT; cat "src/$f.js" >> $OUT; done
echo '</script>' >> $OUT
echo '</body></html>' >> $OUT
echo "built $OUT: $(wc -c < $OUT) bytes"
