#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <string>
#include <system_error>

#include <ggml-backend.h>

#include "qvac-fabric.h"

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace fs = std::filesystem;

namespace {

std::string utf8(const fs::path& path) {
  const auto u8 = path.u8string();
  return {reinterpret_cast<const char*>(u8.data()), u8.size()};
}

// The file this runtime was loaded from, found through an address inside it:
// it is wherever the platform package, bare-link or the APK put it, and only
// the loader knows which.
fs::path runtimePath() {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(&qvac_fabric_backends_dir),
          &module)) {
    return {};
  }
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    const DWORD length = GetModuleFileNameW(
        module, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0)
      return {};
    if (length < buffer.size()) {
      buffer.resize(length);
      return fs::path(buffer);
    }
    buffer.resize(buffer.size() * 2);
  }
#else
  Dl_info info{};
  if (dladdr(reinterpret_cast<void*>(&qvac_fabric_backends_dir), &info) == 0 ||
      info.dli_fname == nullptr) {
    return {};
  }
  return fs::path(info.dli_fname);
#endif
}

std::string findBackendsDir() {
  if (const char* env = std::getenv("QVAC_FABRIC_BACKENDS_DIR");
      env != nullptr && *env != '\0') {
    return env;
  }

  const fs::path self = runtimePath();
  if (self.empty())
    return {};

  const fs::path dir = self.parent_path();
  std::error_code ec;
  const fs::path nested = dir / QVAC_FABRIC_MODULE_NAME;
  if (fs::is_directory(nested, ec))
    return utf8(nested);
  return utf8(dir);
}

std::once_flag g_dirOnce;
std::string g_dir;

std::once_flag g_loadOnce;

#if defined(__ANDROID__) && defined(QVAC_FABRIC_HEXAGON)
void configureHexagonPath(const char* backendsDir) {
  if (*backendsDir == '\0')
    return;
  const fs::path skels = fs::path(backendsDir);
  std::error_code ec;
  bool haveSkel = false;
  for (const int arch : {73, 75, 79, 81}) {
    if (fs::is_regular_file(
            skels / ("libggml-htp-v" + std::to_string(arch) + ".so"), ec)) {
      haveSkel = true;
      break;
    }
  }
  if (!haveSkel)
    return;

  const std::string directory = utf8(skels);
  const char* env = std::getenv("DSP_LIBRARY_PATH");
  // Modern FastRPC prefers DSP_LIBRARY_PATH and preserves its vendor defaults.
  // Carry forward ADSP-only custom paths before establishing the preferred one.
  if (env == nullptr)
    env = std::getenv("ADSP_LIBRARY_PATH");
  const std::string existing = env != nullptr ? env : "";
  // FastRPC separates Android DSP search paths with semicolons.
  const bool alreadyPresent =
      (";" + existing + ";").find(";" + directory + ";") != std::string::npos;
  const std::string searchPath =
      alreadyPresent ? existing
                     : directory + (existing.empty() ? "" : ";" + existing);
  if (setenv("DSP_LIBRARY_PATH", searchPath.c_str(), 1) != 0)
    std::fputs("qvac-fabric: failed to configure DSP_LIBRARY_PATH\n", stderr);
}
#endif

} // namespace

extern "C" const char* qvac_fabric_backends_dir(void) {
  std::call_once(g_dirOnce, [] { g_dir = findBackendsDir(); });
  return g_dir.c_str();
}

extern "C" size_t qvac_fabric_load_backends(void) {
  std::call_once(g_loadOnce, [] {
    const char* path = qvac_fabric_backends_dir();
#if defined(__ANDROID__) && defined(QVAC_FABRIC_HEXAGON)
    configureHexagonPath(path);
#endif
    ggml_backend_load_all_from_path(*path != '\0' ? path : nullptr);
  });
  return ggml_backend_reg_count();
}
