import test from "node:test";
import assert from "node:assert/strict";
import { matchDestructive } from "../packages/attention/src/destructive.js";

test("destructive commands are named by pattern", () => {
  assert.equal(matchDestructive("rm -rf node_modules"), "rm-recursive-force");
  assert.equal(matchDestructive("rm -fr ./build"), "rm-recursive-force");
  assert.equal(matchDestructive("rm --recursive --force dist"), "rm-recursive-force-long");
  assert.equal(matchDestructive("git push --force origin main"), "git-push-force");
  assert.equal(matchDestructive("git push -f"), "git-push-force");
  assert.equal(matchDestructive("git push --force-with-lease"), "git-push-force");
  assert.equal(matchDestructive("git reset --hard HEAD~1"), "git-reset-hard");
  assert.equal(matchDestructive("psql -c 'DROP TABLE users'"), "sql-drop-table");
  assert.equal(matchDestructive("TRUNCATE sessions"), "sql-truncate");
  assert.equal(matchDestructive("DELETE FROM users WHERE 1=1"), "sql-delete-from");
  assert.equal(matchDestructive("npm run db:reset"), "db-reset");
  assert.equal(matchDestructive("npx knex migrate:down"), "migration-down");
  assert.equal(matchDestructive("git clean -fd"), "git-clean-force");
  assert.equal(matchDestructive("git checkout -- ."), "git-checkout-discard");
  assert.equal(matchDestructive("git branch -D feature"), "git-branch-delete");
  assert.equal(matchDestructive("chmod -R 777 /srv"), "chmod-world-writable");
  assert.equal(matchDestructive("kubectl delete deployment api"), "kubectl-delete");
  assert.equal(matchDestructive("terraform destroy -auto-approve"), "terraform-destroy");
  assert.equal(matchDestructive("docker system prune -af"), "docker-prune");
  assert.equal(matchDestructive("git clean --force -d"), "git-clean-force");
  assert.equal(matchDestructive("git clean -d --force"), "git-clean-force");
  assert.equal(matchDestructive("rm -r build -f"), "rm-recursive-force");
  assert.equal(matchDestructive("rm -R ./dist -v -f"), "rm-recursive-force");
});

test("a leading echo hides only its own words", () => {
  assert.equal(matchDestructive("echo done && rm -rf build"), "rm-recursive-force");
  assert.equal(matchDestructive("echo start; git reset --hard HEAD"), "git-reset-hard");
  assert.equal(matchDestructive("echo y | git clean -fd"), "git-clean-force");
  assert.equal(matchDestructive("echo nope || DROP TABLE users"), "sql-drop-table");
  assert.equal(matchDestructive("echo rm -rf build"), null);
  assert.equal(matchDestructive("  echo 'git push --force'"), null);
});

test("ordinary commands are not destructive", () => {
  for (const command of [
    "rm -r --dry-run tmp", "rm file.txt", "git push origin main", "git reset --soft HEAD~1",
    "npm test", "ls -la", "git status", "echo DROP TABLE", "select * from users",
    "git clean -n", "rm -r tmp/old-file", "rm -r a; ls -f",
  ])
    assert.equal(matchDestructive(command), null, command);
});
