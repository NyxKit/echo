#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wincred.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <stdio.h>
#include <wchar.h>
#include <stdlib.h>

static void output(const char *text) { DWORD n;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),text,(DWORD)strlen(text),&n,NULL); }
static PSID current_sid(void) {
  HANDLE token;DWORD size=0;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)) return NULL;
  GetTokenInformation(token,TokenUser,NULL,0,&size);TOKEN_USER *user=malloc(size);
  if(!user || !GetTokenInformation(token,TokenUser,user,size,&size)) { free(user);CloseHandle(token);return NULL; }
  PSID sid=malloc(GetLengthSid(user->User.Sid));if(sid) CopySid(GetLengthSid(user->User.Sid),sid,user->User.Sid);
  free(user);CloseHandle(token);return sid;
}
static int private_path(const wchar_t *path,int protect) {
  DWORD attributes=GetFileAttributesW(path);
  if(attributes==INVALID_FILE_ATTRIBUTES || (attributes&FILE_ATTRIBUTE_REPARSE_POINT)) return 1;
  HANDLE file=CreateFileW(path,READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(file==INVALID_HANDLE_VALUE) return 1;
  BY_HANDLE_FILE_INFORMATION info;
  if(!GetFileInformationByHandle(file,&info) || (!(attributes&FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks!=1)) { CloseHandle(file);return 1; }
  PSID me=current_sid(),owner=NULL;PACL acl=NULL;PSECURITY_DESCRIPTOR sd=NULL;
  if(!me || GetSecurityInfo(file,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,NULL,&acl,NULL,&sd)!=ERROR_SUCCESS || !EqualSid(owner,me)) { free(me);CloseHandle(file);if(sd)LocalFree(sd);return 1; }
  CloseHandle(file);
  if(protect) {
    LPWSTR text=NULL;ConvertSidToStringSidW(me,&text);
    wchar_t sddl[1024];_snwprintf(sddl,1024,L"D:P(A;OICI;FA;;;%ls)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",text);
    PSECURITY_DESCRIPTOR replacement=NULL;PACL dacl=NULL;BOOL present,defaulted;
    int result=1;
    if(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,SDDL_REVISION_1,&replacement,NULL) && GetSecurityDescriptorDacl(replacement,&present,&dacl,&defaulted) &&
       SetNamedSecurityInfoW((LPWSTR)path,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,dacl,NULL)==ERROR_SUCCESS) result=0;
    if(replacement)LocalFree(replacement);LocalFree(text);LocalFree(sd);free(me);return result;
  }
  BYTE system[SECURITY_MAX_SID_SIZE],admin[SECURITY_MAX_SID_SIZE];DWORD a=sizeof(system),b=sizeof(admin);
  CreateWellKnownSid(WinLocalSystemSid,NULL,system,&a);CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,admin,&b);
  int result=acl?0:1;
  if(acl) for(DWORD i=0;i<acl->AceCount;i++) {
    ACE_HEADER *ace;if(!GetAce(acl,i,(void**)&ace)) { result=1;break; }
    if(ace->AceFlags&INHERIT_ONLY_ACE) continue;
    if(ace->AceType==ACCESS_DENIED_ACE_TYPE) continue;
    if(ace->AceType!=ACCESS_ALLOWED_ACE_TYPE) { result=1;break; }
    ACCESS_ALLOWED_ACE *allowed=(ACCESS_ALLOWED_ACE*)ace;PSID sid=&allowed->SidStart;
    if(allowed->Mask && !EqualSid(sid,me) && !EqualSid(sid,system) && !EqualSid(sid,admin)) { result=1;break; }
  }
  LocalFree(sd);free(me);return result;
}
static int lease(const wchar_t *path) {
  HANDLE file=CreateFileW(path,GENERIC_READ|GENERIC_WRITE,0,NULL,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
  if(file==INVALID_HANDLE_VALUE) return GetLastError()==ERROR_SHARING_VIOLATION?73:1;
  output("locked\n");char bytes[32];DWORD n;
  while(ReadFile(GetStdHandle(STD_INPUT_HANDLE),bytes,sizeof(bytes),&n,NULL)&&n) {}
  CloseHandle(file);return 0;
}
static const wchar_t *credential_root=L"Echo.ChatGPT.connection";
static int put_credential(const wchar_t *name,const BYTE *bytes,DWORD size) {
  CREDENTIALW value={0};value.Type=CRED_TYPE_GENERIC;value.TargetName=(LPWSTR)name;value.CredentialBlob=(LPBYTE)bytes;
  value.CredentialBlobSize=size;value.Persist=CRED_PERSIST_LOCAL_MACHINE;return CredWriteW(&value,0)?0:1;
}
static void chunk_name(wchar_t *target,const char *generation,int index) {
  wchar_t wide[33];MultiByteToWideChar(CP_UTF8,0,generation,-1,wide,33);
  _snwprintf(target,160,L"Echo.ChatGPT.connection.%ls.%d",wide,index);
}
static int manifest(char *generation,int *count) {
  PCREDENTIALW root=NULL;if(!CredReadW(credential_root,CRED_TYPE_GENERIC,0,&root)) return GetLastError()==ERROR_NOT_FOUND?2:1;
  char raw[80]={0};if(root->CredentialBlobSize>=sizeof(raw)) { CredFree(root);return 1; }
  memcpy(raw,root->CredentialBlob,root->CredentialBlobSize);CredFree(root);
  if(sscanf(raw,"%32[0123456789abcdef]:%d",generation,count)!=2 || strlen(generation)!=32 || *count<1 || *count>50) return 1;
  return 0;
}
static void cleanup_credentials(const char *keep) {
  PCREDENTIALW *values=NULL;DWORD count=0;wchar_t prefix[128];
  wchar_t wide[33];MultiByteToWideChar(CP_UTF8,0,keep,-1,wide,33);_snwprintf(prefix,128,L"Echo.ChatGPT.connection.%ls.",wide);
  if(CredEnumerateW(L"Echo.ChatGPT.connection.*",0,&count,&values)) {
    for(DWORD i=0;i<count;i++) if(wcsncmp(values[i]->TargetName,prefix,wcslen(prefix))) CredDeleteW(values[i]->TargetName,CRED_TYPE_GENERIC,0);
    CredFree(values);
  }
}
static int credential(int store) {
  if(!store) {
    char generation[33];int count=0,result=manifest(generation,&count);if(result==2)return 0;if(result)return 1;
    BYTE bytes[100000];DWORD size=0;
    for(int i=0;i<count;i++) {
      wchar_t name[160];chunk_name(name,generation,i);PCREDENTIALW value=NULL;
      if(!CredReadW(name,CRED_TYPE_GENERIC,0,&value)) { SecureZeroMemory(bytes,sizeof(bytes));return 1; }
      if(value->CredentialBlobSize>2000 || size+value->CredentialBlobSize>sizeof(bytes)) { CredFree(value);SecureZeroMemory(bytes,sizeof(bytes));return 1; }
      memcpy(bytes+size,value->CredentialBlob,value->CredentialBlobSize);size+=value->CredentialBlobSize;CredFree(value);
    }
    DWORD n;BOOL ok=WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),bytes,size,&n,NULL);SecureZeroMemory(bytes,sizeof(bytes));return ok&&n==size?0:1;
  }
  BYTE bytes[100001],random[16];DWORD size=0,n;
  while(size<sizeof(bytes) && ReadFile(GetStdHandle(STD_INPUT_HANDLE),bytes+size,sizeof(bytes)-size,&n,NULL)&&n) size+=n;
  if(!size || size>100000 || BCryptGenRandom(NULL,random,sizeof(random),BCRYPT_USE_SYSTEM_PREFERRED_RNG)!=0) { SecureZeroMemory(bytes,sizeof(bytes));return 1; }
  char generation[33];for(int i=0;i<16;i++) sprintf(generation+i*2,"%02x",random[i]);
  int count=(int)((size+1999)/2000),result=0;
  for(int i=0;i<count;i++) { wchar_t name[160];chunk_name(name,generation,i);DWORD chunk=size-i*2000;if(chunk>2000)chunk=2000;if(put_credential(name,bytes+i*2000,chunk)) { result=1;break; } }
  SecureZeroMemory(bytes,sizeof(bytes));
  char root[80];sprintf(root,"%s:%d",generation,count);
  if(!result) result=put_credential(credential_root,(BYTE*)root,(DWORD)strlen(root));
  if(!result) cleanup_credentials(generation);
  else for(int i=0;i<count;i++) { wchar_t name[160];chunk_name(name,generation,i);CredDeleteW(name,CRED_TYPE_GENERIC,0); }
  return result;
}
static HWND window;
static NOTIFYICONDATAW icon;
static UINT taskbar_message;
static wchar_t status_text[512]=L"Echo is starting";
static BOOL autostart=FALSE;
static void menu(void) {
  HMENU m=CreatePopupMenu();AppendMenuW(m,MF_STRING|MF_DISABLED,1,status_text);AppendMenuW(m,MF_STRING,2,L"Open Echo / Retry");
  AppendMenuW(m,MF_STRING|(autostart?MF_CHECKED:0),3,L"Start at login");AppendMenuW(m,MF_STRING,4,L"Quit Echo");
  POINT point;GetCursorPos(&point);SetForegroundWindow(window);
  UINT id=TrackPopupMenu(m,TPM_RETURNCMD|TPM_NONOTIFY,point.x,point.y,0,window,NULL);
  DestroyMenu(m);PostMessageW(window,WM_NULL,0,0);
  if(id==2)output("open\n");else if(id==3)output("autostart\n");else if(id==4)output("quit\n");
}
static void add_icon(void) { Shell_NotifyIconW(NIM_ADD,&icon);icon.uVersion=NOTIFYICON_VERSION_4;Shell_NotifyIconW(NIM_SETVERSION,&icon); }
static LRESULT CALLBACK procedure(HWND h,UINT message,WPARAM w,LPARAM l) {
  if(message==taskbar_message && taskbar_message) { add_icon();return 0; }
  if(message==WM_APP+1) { UINT event=LOWORD(l);if(event==WM_CONTEXTMENU)menu();else if(event==NIN_SELECT||event==NIN_KEYSELECT)output("open\n");return 0; }
  if(message==WM_APP+2) {
    char *line=(char*)l;
    if(!strcmp(line,"exit"))PostMessageW(h,WM_CLOSE,0,0);
    else if(!strncmp(line,"autostart ",10))autostart=!strcmp(line+10,"1");
    else if(!strncmp(line,"status ",7)) { MultiByteToWideChar(CP_UTF8,0,line+7,-1,status_text,512);wcsncpy(icon.szTip,status_text,127);icon.szTip[127]=0;Shell_NotifyIconW(NIM_MODIFY,&icon); }
    free(line);return 0;
  }
  if(message==WM_CLOSE) { Shell_NotifyIconW(NIM_DELETE,&icon);DestroyWindow(h);return 0; }
  if(message==WM_DESTROY) { PostQuitMessage(0);return 0; }
  return DefWindowProcW(h,message,w,l);
}
static DWORD WINAPI input_thread(void *unused) {
  (void)unused;char line[501];DWORD n;size_t offset=0;char byte;
  while(ReadFile(GetStdHandle(STD_INPUT_HANDLE),&byte,1,&n,NULL)&&n) {
    if(byte=='\n') { line[offset]=0;char *copy=_strdup(line);if(copy&&!PostMessageW(window,WM_APP+2,0,(LPARAM)copy))free(copy);offset=0; }
    else if(byte!='\r') { if(offset>=500)break;line[offset++]=byte; }
  }
  PostMessageW(window,WM_CLOSE,0,0);return 0;
}
static int tray(HINSTANCE instance) {
  WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=instance;cls.lpszClassName=L"EchoTray";RegisterClassW(&cls);
  window=CreateWindowW(cls.lpszClassName,L"Echo",WS_OVERLAPPED,0,0,0,0,NULL,NULL,instance,NULL);if(!window)return 1;
  taskbar_message=RegisterWindowMessageW(L"TaskbarCreated");memset(&icon,0,sizeof(icon));icon.cbSize=sizeof(icon);icon.hWnd=window;icon.uID=1;
  icon.uFlags=NIF_MESSAGE|NIF_ICON|NIF_TIP;icon.uCallbackMessage=WM_APP+1;icon.hIcon=LoadIconW(NULL,IDI_APPLICATION);wcscpy(icon.szTip,L"Echo");
  if(!Shell_NotifyIconW(NIM_ADD,&icon))return 2;icon.uVersion=NOTIFYICON_VERSION_4;Shell_NotifyIconW(NIM_SETVERSION,&icon);
  HANDLE input=CreateThread(NULL,0,input_thread,NULL,0,NULL);if(!input) { Shell_NotifyIconW(NIM_DELETE,&icon);return 1; }CloseHandle(input);
  output("ready\n");MSG msg;while(GetMessageW(&msg,NULL,0,0)>0) { TranslateMessage(&msg);DispatchMessageW(&msg); }return 0;
}
static int startup(int enabled,const wchar_t *node,const wchar_t *script) {
  HKEY key;if(RegCreateKeyExW(HKEY_CURRENT_USER,L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,NULL,0,KEY_SET_VALUE|KEY_QUERY_VALUE,NULL,&key,NULL)!=ERROR_SUCCESS)return 1;
  LONG result;
  if(enabled<0) { DWORD type,size=0;result=RegQueryValueExW(key,L"Echo",NULL,&type,NULL,&size);output(result==ERROR_SUCCESS?"1":"0");RegCloseKey(key);return 0; }
  if(!enabled) { result=RegDeleteValueW(key,L"Echo");if(result==ERROR_FILE_NOT_FOUND)result=ERROR_SUCCESS; }
  else {
    wchar_t value[32768];
    if(wcschr(node,L'"')||wcschr(script,L'"')) { RegCloseKey(key);return 1; }
    _snwprintf(value,32768,L"\"%ls\" \"%ls\" --login",node,script);
    if(wcslen(value)>260) { RegCloseKey(key);return 1; }
    result=RegSetValueExW(key,L"Echo",0,REG_SZ,(BYTE*)value,(DWORD)((wcslen(value)+1)*sizeof(wchar_t)));
  }
  RegCloseKey(key);return result==ERROR_SUCCESS?0:1;
}
static int launch_app(void) {
  wchar_t path[32768],node[32768],command[32768];if(!GetModuleFileNameW(NULL,path,32768))return 1;
  wchar_t *end=wcsrchr(path,L'\\');if(!end)return 1;*end=0;end=wcsrchr(path,L'\\');if(!end)return 1;*end=0;
  _snwprintf(node,32768,L"%ls\\runtime\\node.exe",path);
  _snwprintf(command,32768,L"\"%ls\" \"%ls\\server\\cli.mjs\" start",node,path);
  STARTUPINFOW start={0};start.cb=sizeof(start);PROCESS_INFORMATION child={0};
  if(!CreateProcessW(node,command,NULL,NULL,FALSE,CREATE_NO_WINDOW,NULL,path,&start,&child))return 1;
  CloseHandle(child.hThread);WaitForSingleObject(child.hProcess,20000);DWORD code=1;GetExitCodeProcess(child.hProcess,&code);CloseHandle(child.hProcess);
  if(code!=0)MessageBoxW(NULL,L"Echo could not open. Retry the launcher, or run server:status to check a port conflict or unavailable local storage.",L"Echo",MB_OK|MB_ICONERROR);
  return code==0?0:1;
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,LPWSTR command,int show) {
  (void)previous;(void)command;(void)show;int argc;wchar_t **argv=CommandLineToArgvW(GetCommandLineW(),&argc);if(!argv)return 1;
  int result=1;
  if(argc==1)result=launch_app();
  else if(!wcscmp(argv[1],L"--probe"))result=0;
  else if(argc==2&&!wcscmp(argv[1],L"tray"))result=tray(instance);
  else if(argc==3&&!wcscmp(argv[1],L"lock"))result=lease(argv[2]);
  else if(argc==3&&!wcscmp(argv[1],L"private-check"))result=private_path(argv[2],0);
  else if(argc==3&&!wcscmp(argv[1],L"private-protect"))result=private_path(argv[2],1);
  else if(argc==2&&!wcscmp(argv[1],L"credential-lookup"))result=credential(0);
  else if(argc==2&&!wcscmp(argv[1],L"credential-store"))result=credential(1);
  else if(argc==3&&!wcscmp(argv[1],L"open"))result=(INT_PTR)ShellExecuteW(NULL,L"open",argv[2],NULL,NULL,SW_SHOWNORMAL)>32?0:1;
  else if(argc==2&&!wcscmp(argv[1],L"autostart-status"))result=startup(-1,NULL,NULL);
  else if(argc==2&&!wcscmp(argv[1],L"autostart-disable"))result=startup(0,NULL,NULL);
  else if(argc==4&&!wcscmp(argv[1],L"autostart-enable"))result=startup(1,argv[2],argv[3]);
  LocalFree(argv);return result;
}
