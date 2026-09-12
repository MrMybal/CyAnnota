"""Check tracked/staged files without printing credential values or personal paths."""
import argparse
import hashlib
import pathlib
import re
import subprocess
import sys

PROFILE_PATH = re.compile(rb"(?i)[a-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<)[A-Za-z0-9_.-]+")
LOCAL_PROJECT = re.compile(rb"(?i)[a-z]:[\\/]+_Project[\\/]+")
PRIVATE_KEY = re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")
NATIVE_SOURCE = re.compile(rb"[A-Za-z]:[\\/][\x20-\x7e]+[\\/]Source[\\/][\x20-\x7e]+\.(?:cpp|h|hpp|inl)\x00")
MEDIA_SUFFIXES = ('.png','.jpg','.jpeg','.webp','.gif','.svg','.mp4','.webm','.mov','.avi','.mkv')
REVIEWED_PUBLIC_MEDIA = {
    'docs/screenshots/01-home.png':'794f2e6ba92f5879b229f1c5d79fb6f4fcc05e4275c91bf3e6c71e6148fd59e3',
    'public/cyannota-logo.png':'cd8bdf9811ad84aa9d3ff1e24e7c1b74cc0c1fdd9a4f3dd2f24f878a59ea2610',
    'public/favicon.svg':'e6d2e59b7b5bbb0342e0fb496dfc262decbfe4426bbb7b047aec8d467d1dc6f7',
}

def git(*args):
    return subprocess.check_output(['git', *args])

def forbidden_path(path):
    parts = pathlib.PurePosixPath(path).parts
    lower_parts = {part.lower() for part in parts}
    name = parts[-1]
    lower_name = name.lower()
    return (any(part in {'.codex','.cyrevision','.vs','.openai','release','outputs','work','exports','captures','recordings','private-media','screenshots-local'} for part in lower_parts)
            or (lower_name.startswith('.env') and lower_name not in {'.env.example','.env.sample','.env.template'})
            or lower_name in {'appsettings.local.json','id_rsa','id_ed25519','credentials.json'}
            or lower_name.endswith(('.cyannota','.cyannota.zip','.zip','.7z','.rar','.exe','.msi','.pfx','.p12','.key','.dmp','.etl','.suo','.pubxml.user')))

def inspect(path,data):
    issues = []
    if forbidden_path(path):issues.append('private/local file')
    texts = [data]
    if b'\0' in data[:8192]:
        texts.append(b'\n'.join(s[::2] for s in re.findall(rb'(?:[\x20-\x7e]\x00){6,}',data)))
    for rule,pattern in [('Windows user profile path',PROFILE_PATH),('local project path',LOCAL_PROJECT),('private key',PRIVATE_KEY)]:
        if any(pattern.search(t) for t in texts):issues.append(rule)
    if data.startswith(b'MZ') and NATIVE_SOURCE.search(data):issues.append('native diagnostic source path')
    if path.lower().endswith(MEDIA_SUFFIXES):
        expected = REVIEWED_PUBLIC_MEDIA.get(path)
        digest = hashlib.sha256(data).hexdigest()
        if expected is None:issues.append('unreviewed public media')
        elif digest != expected:issues.append('reviewed public media changed; update its approved digest')
    return issues

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged',action='store_true')
    args=parser.parse_args()
    if args.staged:
        entries=git('ls-files','--stage','-z').split(b'\0')
        files=[]
        for entry in entries:
            if not entry:continue
            meta,path=entry.split(b'\t',1)
            if meta.split()[0]==b'100644' or meta.split()[0]==b'100755':
                files.append((meta.split()[1],path.decode('utf8')))
        emails=[git('config','user.email').strip().lower()]
    else:
        files=[]
        for entry in git('ls-tree','-rz','HEAD').split(b'\0'):
            if not entry:continue
            meta,path=entry.split(b'\t',1)
            if meta.split()[1]==b'blob':files.append((meta.split()[2],path.decode('utf8')))
        emails=set(git('log','--all','--format=%ae%n%ce').lower().splitlines())
        emails.update(git('for-each-ref','--format=%(taggeremail)','refs/tags').lower().replace(b'<',b'').replace(b'>',b'').splitlines())
    issues=[]
    proc=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    for oid,path in files:
        proc.stdin.write(oid+b'\n');proc.stdin.flush()
        header=proc.stdout.readline().split();data=proc.stdout.read(int(header[2]));proc.stdout.read(1)
        for reason in inspect(path,data):issues.append(f'{path}: {reason}')
    proc.stdin.close();proc.wait()
    bad_emails=[e for e in emails if e and not (e.endswith(b'@users.noreply.github.com') or e==b'noreply@github.com')]
    if bad_emails:issues.append('Commit/tag identity must use a GitHub noreply email address.')
    if issues:
        print('\n'.join(issues),file=sys.stderr)
        return 1
    print(f'Privacy checks passed for {len(files)} files and commit/tag identities.')
    return 0

if __name__=='__main__':sys.exit(main())
