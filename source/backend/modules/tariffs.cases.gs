      case 'getTariffs': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        result = getTariffs();
        break;
      }

      case 'saveTariff': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        result = saveTariff(data.tariff);
        break;
      }